import Database from 'better-sqlite3';
import { parse } from 'csv-parse/sync';
import {
  ParsedSettlementRecord,
  ReconciliationResult,
  ReconciliationRun,
  ReconciliationRunItem,
  SettlementHistory,
  CSVPreviewResult,
  CSVPreviewRow,
  SettlementType,
  Transaction
} from '../types/index.js';
import { toCents, fromCents } from '../utils/money.js';
import { validateAndTransformCSVRecord } from '../validators/csv.validator.js';
import { MatchingService } from './matching.service.js';
import { SettlementService } from './settlement.service.js';
import { runMigrations } from '../db/migrations.js';

export class ReconciliationService {
  private matchingService: MatchingService;
  private settlementService: SettlementService;
  private stmtGetExistingSettlement: Database.Statement;
  private stmtInsertSettlement: Database.Statement;
  private stmtInsertRun: Database.Statement;
  private stmtUpdateRun: Database.Statement;
  private stmtInsertRunItem: Database.Statement;

  constructor(private db: Database.Database) {
    runMigrations(this.db);

    this.matchingService = new MatchingService(db);
    this.settlementService = new SettlementService(db);

    this.stmtGetExistingSettlement = this.db.prepare<[string]>(
      'SELECT * FROM settlement_history WHERE settlement_id = ?'
    );

    // Support run_id and match_method columns if present
    this.stmtInsertSettlement = this.db.prepare(
      `INSERT INTO settlement_history (
        settlement_id, transaction_id, lifecycle_id, settlement_date,
        settlement_amount, settlement_type, currency, run_id, match_method, processed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    this.stmtInsertRun = this.db.prepare(
      `INSERT INTO reconciliation_runs (
        run_id, file_name, file_size_bytes, status, records_read,
        matched_records, new_settlements_inserted, duplicates_skipped,
        invalid_records, unmatched_records, ambiguous_records,
        transactions_updated, duration_ms, error_message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    this.stmtUpdateRun = this.db.prepare(
      `UPDATE reconciliation_runs SET
        status = ?, records_read = ?, matched_records = ?,
        new_settlements_inserted = ?, duplicates_skipped = ?,
        invalid_records = ?, unmatched_records = ?, ambiguous_records = ?,
        transactions_updated = ?, duration_ms = ?, error_message = ?
      WHERE run_id = ?`
    );

    this.stmtInsertRunItem = this.db.prepare(
      `INSERT INTO reconciliation_run_items (
        run_id, row_number, settlement_id, item_type, reason, raw_data
      ) VALUES (?, ?, ?, ?, ?, ?)`
    );
  }

  public previewCSV(
    csvContent: string,
    fileName: string = 'settlement_upload.csv',
    fileSizeBytes: number = 0
  ): CSVPreviewResult {
    let rawRecords: any[] = [];
    const errors: Array<{ rowNumber?: number; error: string }> = [];

    const REQUIRED_COLUMNS = [
      'settlement_id',
      'account_id',
      'merchant_name',
      'transaction_date',
      'settlement_date',
      'settlement_amount',
      'settlement_type',
      'currency'
    ];

    if (!csvContent || csvContent.trim().length === 0) {
      return {
        success: false,
        fileName,
        fileSizeBytes,
        totalRows: 0,
        validRows: 0,
        invalidRows: 0,
        duplicateRows: 0,
        columnsFound: [],
        missingColumns: REQUIRED_COLUMNS,
        previewRows: [],
        errors: [{ error: 'CSV content is empty. Please upload a file with data.' }]
      };
    }

    try {
      rawRecords = parse(csvContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true
      });
    } catch (parseErr: any) {
      return {
        success: false,
        fileName,
        fileSizeBytes,
        totalRows: 0,
        validRows: 0,
        invalidRows: 1,
        duplicateRows: 0,
        columnsFound: [],
        missingColumns: [],
        previewRows: [],
        errors: [{ error: `Malformed CSV file: ${parseErr.message}` }]
      };
    }

    if (rawRecords.length === 0) {
      return {
        success: false,
        fileName,
        fileSizeBytes,
        totalRows: 0,
        validRows: 0,
        invalidRows: 0,
        duplicateRows: 0,
        columnsFound: [],
        missingColumns: [],
        previewRows: [],
        errors: [{ error: 'CSV file contains headers but no data rows.' }]
      };
    }

    const firstRowKeys = Object.keys(rawRecords[0] || {});
    const missingColumns = REQUIRED_COLUMNS.filter(col => !firstRowKeys.includes(col));

    if (missingColumns.length > 0) {
      return {
        success: false,
        fileName,
        fileSizeBytes,
        totalRows: rawRecords.length,
        validRows: 0,
        invalidRows: rawRecords.length,
        duplicateRows: 0,
        columnsFound: firstRowKeys,
        missingColumns,
        previewRows: [],
        errors: [{ error: `Missing required CSV column headers: ${missingColumns.join(', ')}` }]
      };
    }

    let validRows = 0;
    let invalidRows = 0;
    let duplicateRows = 0;
    const previewRows: CSVPreviewRow[] = [];

    // Analyze first 500 rows for preview performance
    const rowsToInspect = rawRecords.slice(0, 500);

    rowsToInspect.forEach((raw, idx) => {
      const rowNum = idx + 2;
      const validation = validateAndTransformCSVRecord(raw, rowNum);

      if (!validation.success || !validation.data) {
        invalidRows++;
        previewRows.push({
          row_number: rowNum,
          settlement_id: raw.settlement_id || `ROW_${rowNum}`,
          lifecycle_id: raw.lifecycle_id || null,
          account_id: raw.account_id || '',
          merchant_name: raw.merchant_name || '',
          transaction_date: raw.transaction_date || '',
          settlement_date: raw.settlement_date || '',
          settlement_amount: parseFloat(raw.settlement_amount) || null,
          settlement_type: raw.settlement_type || 'UNKNOWN',
          currency: raw.currency || 'USD',
          status: 'INVALID',
          status_message: validation.error || 'Validation failed'
        });
        return;
      }

      const rec = validation.data;
      const existing = this.stmtGetExistingSettlement.get(rec.settlement_id) as SettlementHistory | undefined;

      if (existing) {
        const isIdentical =
          existing.settlement_amount === rec.settlement_amount &&
          existing.settlement_type === rec.settlement_type &&
          existing.currency === rec.currency &&
          existing.settlement_date === rec.settlement_date;

        if (isIdentical) {
          duplicateRows++;
          previewRows.push({
            row_number: rowNum,
            settlement_id: rec.settlement_id,
            lifecycle_id: rec.lifecycle_id,
            account_id: rec.account_id,
            merchant_name: rec.merchant_name,
            transaction_date: rec.transaction_date,
            settlement_date: rec.settlement_date,
            settlement_amount: rec.settlement_amount,
            settlement_type: rec.settlement_type,
            currency: rec.currency,
            status: 'DUPLICATE',
            status_message: 'Identical settlement record previously ingested. Will be safely skipped.'
          });
        } else {
          invalidRows++;
          previewRows.push({
            row_number: rowNum,
            settlement_id: rec.settlement_id,
            lifecycle_id: rec.lifecycle_id,
            account_id: rec.account_id,
            merchant_name: rec.merchant_name,
            transaction_date: rec.transaction_date,
            settlement_date: rec.settlement_date,
            settlement_amount: rec.settlement_amount,
            settlement_type: rec.settlement_type,
            currency: rec.currency,
            status: 'CONFLICT',
            status_message: `Conflicting data: Settlement ID "${rec.settlement_id}" already exists with different values.`
          });
        }
        return;
      }

      // Match check
      const match = this.matchingService.match(rec);

      if (match.status === 'MATCHED' && match.transaction) {
        if (match.transaction.status === 'FAILED' || match.transaction.status === 'DECLINED') {
          previewRows.push({
            row_number: rowNum,
            settlement_id: rec.settlement_id,
            lifecycle_id: rec.lifecycle_id,
            account_id: rec.account_id,
            merchant_name: rec.merchant_name,
            transaction_date: rec.transaction_date,
            settlement_date: rec.settlement_date,
            settlement_amount: rec.settlement_amount,
            settlement_type: rec.settlement_type,
            currency: rec.currency,
            status: 'POTENTIAL_UNMATCHED',
            status_message: `Matched transaction ${match.transaction.transaction_id} is in "${match.transaction.status}" status and cannot be settled.`,
            matched_transaction_id: match.transaction.transaction_id
          });
        } else {
          validRows++;
          previewRows.push({
            row_number: rowNum,
            settlement_id: rec.settlement_id,
            lifecycle_id: rec.lifecycle_id,
            account_id: rec.account_id,
            merchant_name: rec.merchant_name,
            transaction_date: rec.transaction_date,
            settlement_date: rec.settlement_date,
            settlement_amount: rec.settlement_amount,
            settlement_type: rec.settlement_type,
            currency: rec.currency,
            status: 'VALID_MATCH',
            status_message: `Ready for reconciliation via ${match.matchType === 'PRIMARY_LIFECYCLE' ? 'Primary Lifecycle ID' : 'Fallback composite key'}.`,
            matched_transaction_id: match.transaction.transaction_id
          });
        }
      } else if (match.status === 'CURRENCY_MISMATCH') {
        invalidRows++;
        previewRows.push({
          row_number: rowNum,
          settlement_id: rec.settlement_id,
          lifecycle_id: rec.lifecycle_id,
          account_id: rec.account_id,
          merchant_name: rec.merchant_name,
          transaction_date: rec.transaction_date,
          settlement_date: rec.settlement_date,
          settlement_amount: rec.settlement_amount,
          settlement_type: rec.settlement_type,
          currency: rec.currency,
          status: 'CURRENCY_MISMATCH',
          status_message: match.reason || 'Currency mismatch with internal ledger record.'
        });
      } else if (match.status === 'AMBIGUOUS') {
        previewRows.push({
          row_number: rowNum,
          settlement_id: rec.settlement_id,
          lifecycle_id: rec.lifecycle_id,
          account_id: rec.account_id,
          merchant_name: rec.merchant_name,
          transaction_date: rec.transaction_date,
          settlement_date: rec.settlement_date,
          settlement_amount: rec.settlement_amount,
          settlement_type: rec.settlement_type,
          currency: rec.currency,
          status: 'AMBIGUOUS',
          status_message: match.reason || 'Ambiguous match: multiple transactions match this settlement record.'
        });
      } else {
        previewRows.push({
          row_number: rowNum,
          settlement_id: rec.settlement_id,
          lifecycle_id: rec.lifecycle_id,
          account_id: rec.account_id,
          merchant_name: rec.merchant_name,
          transaction_date: rec.transaction_date,
          settlement_date: rec.settlement_date,
          settlement_amount: rec.settlement_amount,
          settlement_type: rec.settlement_type,
          currency: rec.currency,
          status: 'POTENTIAL_UNMATCHED',
          status_message: match.reason || 'No corresponding transaction found in ledger.'
        });
      }
    });

    return {
      success: true,
      fileName,
      fileSizeBytes: fileSizeBytes || Buffer.byteLength(csvContent, 'utf-8'),
      totalRows: rawRecords.length,
      validRows,
      invalidRows,
      duplicateRows,
      columnsFound: firstRowKeys,
      missingColumns: [],
      previewRows,
      errors
    };
  }

  public reconcileCSV(
    csvContent: string,
    options?: { fileName?: string; fileSizeBytes?: number }
  ): ReconciliationResult {
    const startTime = Date.now();
    const runId = `RUN_${Date.now()}_${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
    const fileName = options?.fileName || 'settlement_batch.csv';
    const fileSizeBytes = options?.fileSizeBytes || Buffer.byteLength(csvContent || '', 'utf-8');

    const runCreatedAt = new Date().toISOString();
    // Create initial run record outside the business transaction
    this.stmtInsertRun.run(
      runId,
      fileName,
      fileSizeBytes,
      'IN_PROGRESS',
      0, 0, 0, 0, 0, 0, 0, 0, 0, null,
      runCreatedAt
    );

    let rawRecords: any[];
    try {
      rawRecords = parse(csvContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true
      });
    } catch (parseErr: any) {
      const durationMs = Date.now() - startTime;
      this.stmtUpdateRun.run(
        'FAILED', 0, 0, 0, 0, 1, 0, 0, 0, durationMs,
        `CSV Parsing Failed: ${parseErr.message}`,
        runId
      );

      this.stmtInsertRunItem.run(
        runId, 1, null, 'INVALID',
        `CSV Parsing Failed: ${parseErr.message}`,
        null
      );

      return {
        success: false,
        runId,
        summary: {
          recordsRead: 0,
          matchedRecords: 0,
          newSettlementsInserted: 0,
          duplicatesSkipped: 0,
          invalidRecords: 1,
          unmatchedRecords: 0,
          transactionsUpdated: 0
        },
        errors: [{ error: `CSV Parsing Failed: ${parseErr.message}` }],
        unmatched: []
      };
    }

    const summary = {
      recordsRead: rawRecords.length,
      matchedRecords: 0,
      newSettlementsInserted: 0,
      duplicatesSkipped: 0,
      invalidRecords: 0,
      unmatchedRecords: 0,
      ambiguousRecords: 0,
      transactionsUpdated: 0
    };

    const errors: ReconciliationResult['errors'] = [];
    const unmatched: ReconciliationResult['unmatched'] = [];
    const affectedTxnIds = new Set<string>();

    try {
      // Execute matching & inserts inside atomic SQLite transaction
      const executeReconciliation = this.db.transaction(() => {
        rawRecords.forEach((raw, index) => {
          const rowNum = index + 2; // header offset

          // 1. Validate fields
          const validation = validateAndTransformCSVRecord(raw, rowNum);
          if (!validation.success || !validation.data) {
            summary.invalidRecords++;
            const errMsg = validation.error || 'Validation failed';
            errors.push({
              rowNumber: rowNum,
              recordId: raw.settlement_id || undefined,
              error: errMsg
            });

            this.stmtInsertRunItem.run(
              runId,
              rowNum,
              raw.settlement_id || null,
              'INVALID',
              errMsg,
              JSON.stringify(raw)
            );
            return;
          }

          const record = validation.data;

          // 2. Duplicate Detection
          const existing = this.stmtGetExistingSettlement.get(record.settlement_id) as SettlementHistory | undefined;
          if (existing) {
            const isIdentical =
              existing.settlement_amount === record.settlement_amount &&
              existing.settlement_type === record.settlement_type &&
              existing.currency === record.currency &&
              existing.settlement_date === record.settlement_date;

            if (isIdentical) {
              summary.duplicatesSkipped++;
              this.stmtInsertRunItem.run(
                runId,
                rowNum,
                record.settlement_id,
                'SKIPPED_DUPLICATE',
                'Identical settlement record previously ingested',
                JSON.stringify(raw)
              );
              return;
            } else {
              summary.invalidRecords++;
              const conflictMsg = `Conflicting duplicate: settlement_id "${record.settlement_id}" already exists with different data (incoming: $${record.settlement_amount} ${record.settlement_type} ${record.currency} on ${record.settlement_date} vs existing: $${existing.settlement_amount} ${existing.settlement_type} ${existing.currency} on ${existing.settlement_date}).`;
              errors.push({
                rowNumber: rowNum,
                recordId: record.settlement_id,
                error: conflictMsg
              });
              this.stmtInsertRunItem.run(
                runId,
                rowNum,
                record.settlement_id,
                'CONFLICT',
                conflictMsg,
                JSON.stringify(raw)
              );
              return;
            }
          }

          // 3. Match against transactions
          const matchResult = this.matchingService.match(record);

          if (matchResult.status === 'MATCHED' && matchResult.transaction) {
            const matchedTxn = matchResult.transaction;

            // Guard: Transactions in FAILED or DECLINED status cannot receive settlements
            if (matchedTxn.status === 'FAILED' || matchedTxn.status === 'DECLINED') {
              summary.unmatchedRecords++;
              const reason = `Matched transaction ${matchedTxn.transaction_id} is in "${matchedTxn.status}" state and cannot be settled.`;
              unmatched.push({
                settlement_id: record.settlement_id,
                reason,
                record
              });
              this.stmtInsertRunItem.run(
                runId,
                rowNum,
                record.settlement_id,
                'UNMATCHED',
                reason,
                JSON.stringify(raw)
              );
              return;
            }

            // Valid match
            summary.matchedRecords++;

            this.stmtInsertSettlement.run(
              record.settlement_id,
              matchedTxn.transaction_id,
              record.lifecycle_id || matchedTxn.lifecycle_id,
              record.settlement_date,
              record.settlement_amount,
              record.settlement_type,
              record.currency,
              runId,
              matchResult.matchType || 'PRIMARY_LIFECYCLE',
              runCreatedAt
            );

            this.stmtInsertRunItem.run(
              runId,
              rowNum,
              record.settlement_id,
              'MATCHED',
              `Reconciled with ${matchedTxn.transaction_id} via ${matchResult.matchType}`,
              JSON.stringify(raw)
            );

            summary.newSettlementsInserted++;
            affectedTxnIds.add(matchedTxn.transaction_id);
          } else {
            // Unmatched, ambiguous, or currency mismatch
            summary.unmatchedRecords++;
            if (matchResult.status === 'AMBIGUOUS') {
              summary.ambiguousRecords = (summary.ambiguousRecords || 0) + 1;
            }

            const itemType = matchResult.status === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'UNMATCHED';
            const reason = matchResult.reason || 'Unmatched settlement record';

            unmatched.push({
              settlement_id: record.settlement_id,
              reason,
              record
            });

            this.stmtInsertRunItem.run(
              runId,
              rowNum,
              record.settlement_id,
              itemType,
              reason,
              JSON.stringify(raw)
            );
          }
        });

        // 4. Recalculate all affected transactions
        affectedTxnIds.forEach(txnId => {
          this.settlementService.recalculateTransaction(txnId);
          summary.transactionsUpdated++;
        });
      });

      executeReconciliation();

      const durationMs = Date.now() - startTime;
      const runStatus = (summary.invalidRecords > 0 || summary.unmatchedRecords > 0)
        ? 'PARTIAL'
        : 'COMPLETED';

      this.stmtUpdateRun.run(
        runStatus,
        summary.recordsRead,
        summary.matchedRecords,
        summary.newSettlementsInserted,
        summary.duplicatesSkipped,
        summary.invalidRecords,
        summary.unmatchedRecords,
        summary.ambiguousRecords || 0,
        summary.transactionsUpdated,
        durationMs,
        null,
        runId
      );

      return {
        success: true,
        runId,
        summary,
        errors,
        unmatched
      };
    } catch (txErr: any) {
      const durationMs = Date.now() - startTime;
      this.stmtUpdateRun.run(
        'FAILED',
        summary.recordsRead,
        summary.matchedRecords,
        0,
        summary.duplicatesSkipped,
        summary.invalidRecords + 1,
        summary.unmatchedRecords,
        summary.ambiguousRecords || 0,
        0,
        durationMs,
        `Transaction rolled back: ${txErr.message}`,
        runId
      );

      throw txErr;
    }
  }

  public getRuns(limit: number = 50, offset: number = 0): { total: number; runs: ReconciliationRun[] } {
    const totalRow = this.db.prepare('SELECT COUNT(*) as count FROM reconciliation_runs').get() as { count: number };
    const runs = this.db.prepare(
      'SELECT * FROM reconciliation_runs ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).all(limit, offset) as ReconciliationRun[];

    const normalizedRuns = runs.map(r => {
      let cAt = r.created_at;
      if (cAt && !cAt.includes('T')) {
        cAt = cAt.replace(' ', 'T') + 'Z';
      }
      return { ...r, created_at: cAt };
    });

    return { total: totalRow.count, runs: normalizedRuns };
  }

  public getRunById(runId: string): { run: ReconciliationRun; items: ReconciliationRunItem[] } | null {
    const run = this.db.prepare('SELECT * FROM reconciliation_runs WHERE run_id = ?').get(runId) as ReconciliationRun | undefined;
    if (!run) return null;

    let cAt = run.created_at;
    if (cAt && !cAt.includes('T')) {
      cAt = cAt.replace(' ', 'T') + 'Z';
    }

    const items = this.db.prepare(
      'SELECT * FROM reconciliation_run_items WHERE run_id = ? ORDER BY id ASC'
    ).all(runId) as ReconciliationRunItem[];

    return { run: { ...run, created_at: cAt }, items };
  }

  public getRejectedItemsCSV(runId: string): string {
    const items = this.db.prepare(
      `SELECT row_number, settlement_id, item_type, reason, raw_data
       FROM reconciliation_run_items
       WHERE run_id = ? AND item_type IN ('INVALID', 'UNMATCHED', 'AMBIGUOUS', 'CONFLICT')
       ORDER BY id ASC`
    ).all(runId) as any[];

    const headers = ['row_number', 'settlement_id', 'issue_type', 'reason', 'raw_record'];
    const rows = items.map(item => [
      item.row_number || '',
      item.settlement_id || '',
      item.item_type || '',
      `"${(item.reason || '').replace(/"/g, '""')}"`,
      `"${(item.raw_data || '').replace(/"/g, '""')}"`
    ]);

    return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  }

  public deleteRun(runId: string): boolean {
    const run = this.db.prepare('SELECT run_id FROM reconciliation_runs WHERE run_id = ?').get(runId);
    if (!run) return false;

    // 1. Find all affected transactions
    const affectedTxns = this.db.prepare(
      'SELECT DISTINCT transaction_id FROM settlement_history WHERE run_id = ? AND transaction_id IS NOT NULL'
    ).all(runId) as { transaction_id: string }[];

    const deleteTx = this.db.transaction(() => {
      // 2. Delete run items
      this.db.prepare('DELETE FROM reconciliation_run_items WHERE run_id = ?').run(runId);

      // 3. Delete settlement records
      this.db.prepare('DELETE FROM settlement_history WHERE run_id = ?').run(runId);

      // 4. Delete the run itself
      this.db.prepare('DELETE FROM reconciliation_runs WHERE run_id = ?').run(runId);

      // 5. Recalculate each affected transaction
      for (const { transaction_id } of affectedTxns) {
        const txn = this.db.prepare('SELECT * FROM transactions WHERE transaction_id = ?').get(transaction_id) as Transaction | undefined;
        if (!txn) continue;

        const remainingSettlements = this.db.prepare(
          'SELECT settlement_amount, settlement_type, settlement_date FROM settlement_history WHERE transaction_id = ? ORDER BY settlement_date ASC'
        ).all(transaction_id) as { settlement_amount: number; settlement_type: string; settlement_date: string }[];

        if (remainingSettlements.length === 0) {
          const defaultStatus = (txn.status === 'FAILED' || txn.status === 'DECLINED') ? 'NOT_APPLICABLE' : 'PENDING';
          this.db.prepare(
            'UPDATE transactions SET total_settled_amount = 0.00, last_settlement_date = NULL, settlement_status = ? WHERE transaction_id = ?'
          ).run(defaultStatus, transaction_id);
        } else {
          let netCents = 0;
          let hasCredit = false;
          let latestDate = remainingSettlements[0].settlement_date;

          for (const s of remainingSettlements) {
            const sCents = toCents(s.settlement_amount);
            if (s.settlement_type === 'DEBIT') {
              netCents += sCents;
            } else {
              netCents -= sCents;
              hasCredit = true;
            }
            if (s.settlement_date > latestDate) {
              latestDate = s.settlement_date;
            }
          }

          const targetCents = toCents(txn.transaction_amount);
          let newStatus = 'PENDING';
          if (netCents === targetCents) {
            newStatus = 'FULLY_SETTLED';
          } else if (netCents > targetCents) {
            newStatus = 'OVER_SETTLED';
          } else if (netCents < targetCents && hasCredit) {
            newStatus = 'REFUNDED';
          } else if (netCents > 0) {
            newStatus = 'PARTIAL';
          } else {
            newStatus = 'PENDING';
          }

          this.db.prepare(
            'UPDATE transactions SET total_settled_amount = ?, last_settlement_date = ?, settlement_status = ? WHERE transaction_id = ?'
          ).run(fromCents(netCents), latestDate, newStatus, transaction_id);
        }
      }
    });

    deleteTx();
    return true;
  }
}
