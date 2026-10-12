import Database from 'better-sqlite3';
import { parse } from 'csv-parse/sync';
import {
  ParsedSettlementRecord,
  ReconciliationResult,
  SettlementHistory
} from '../types/index.js';
import { validateAndTransformCSVRecord } from '../validators/csv.validator.js';
import { MatchingService } from './matching.service.js';
import { SettlementService } from './settlement.service.js';

export class ReconciliationService {
  private matchingService: MatchingService;
  private settlementService: SettlementService;
  private stmtGetExistingSettlement: Database.Statement;
  private stmtInsertSettlement: Database.Statement;

  constructor(private db: Database.Database) {
    this.matchingService = new MatchingService(db);
    this.settlementService = new SettlementService(db);

    this.stmtGetExistingSettlement = this.db.prepare<[string]>(
      'SELECT * FROM settlement_history WHERE settlement_id = ?'
    );
    this.stmtInsertSettlement = this.db.prepare<[string, string, string | null, string, number, string, string]>(
      `INSERT INTO settlement_history (
        settlement_id, transaction_id, lifecycle_id, settlement_date,
        settlement_amount, settlement_type, currency
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
  }

  public reconcileCSV(csvContent: string): ReconciliationResult {
    let rawRecords: any[];
    try {
      rawRecords = parse(csvContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true
      });
    } catch (parseErr: any) {
      return {
        success: false,
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
      transactionsUpdated: 0
    };

    const errors: ReconciliationResult['errors'] = [];
    const unmatched: ReconciliationResult['unmatched'] = [];
    const affectedTxnIds = new Set<string>();

    // Execute matching & inserts inside atomic transaction
    const executeReconciliation = this.db.transaction(() => {
      rawRecords.forEach((raw, index) => {
        const rowNum = index + 2; // account for header line

        // 1. Validate fields
        const validation = validateAndTransformCSVRecord(raw, rowNum);
        if (!validation.success || !validation.data) {
          summary.invalidRecords++;
          errors.push({
            rowNumber: rowNum,
            recordId: raw.settlement_id || undefined,
            error: validation.error || 'Validation failed'
          });
          return;
        }

        const record = validation.data;

        // 2. Duplicate Detection
        const existing = this.stmtGetExistingSettlement.get(record.settlement_id) as SettlementHistory | undefined;
        if (existing) {
          // Check if data matches or conflicts
          const isIdentical =
            existing.settlement_amount === record.settlement_amount &&
            existing.settlement_type === record.settlement_type &&
            existing.currency === record.currency &&
            existing.settlement_date === record.settlement_date;

          if (isIdentical) {
            summary.duplicatesSkipped++;
            return;
          } else {
            summary.invalidRecords++;
            errors.push({
              rowNumber: rowNum,
              recordId: record.settlement_id,
              error: `Conflicting duplicate: settlement_id "${record.settlement_id}" already exists with different data.`
            });
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
            unmatched.push({
              settlement_id: record.settlement_id,
              reason: `Matched transaction ${matchedTxn.transaction_id} is in "${matchedTxn.status}" state and cannot be settled.`,
              record
            });
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
            record.currency
          );

          summary.newSettlementsInserted++;
          affectedTxnIds.add(matchedTxn.transaction_id);
        } else {
          // Unmatched, ambiguous, or currency mismatch
          summary.unmatchedRecords++;
          unmatched.push({
            settlement_id: record.settlement_id,
            reason: matchResult.reason || 'Unmatched settlement record',
            record
          });
        }
      });

      // 4. Recalculate all affected transactions
      affectedTxnIds.forEach(txnId => {
        this.settlementService.recalculateTransaction(txnId);
        summary.transactionsUpdated++;
      });
    });

    executeReconciliation();

    return {
      success: true,
      summary,
      errors,
      unmatched
    };
  }
}
