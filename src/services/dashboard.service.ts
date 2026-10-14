import Database from 'better-sqlite3';
import { DashboardSummary, SettlementStatus, Transaction } from '../types/index.js';
import { IssueDetectionService } from './issue-detection.service.js';
import { fromCents, toCents } from '../utils/money.js';

export class DashboardService {
  private issueService: IssueDetectionService;

  constructor(private db: Database.Database) {
    this.issueService = new IssueDetectionService();
  }

  public getSummary(evaluationDate?: string, runId?: string): DashboardSummary {
    const cleanRunId = (runId && runId.trim() !== '' && runId !== 'ALL') ? runId.trim() : null;
    let allTxns: Transaction[] = [];
    let totalSettlementRecords = 0;
    let runRecord: any = null;

    if (cleanRunId) {
      try {
        runRecord = this.db.prepare('SELECT * FROM reconciliation_runs WHERE run_id = ?').get(cleanRunId);
      } catch (e) {}

      const runTxnRows = this.db.prepare(
        'SELECT DISTINCT transaction_id FROM settlement_history WHERE run_id = ? AND transaction_id IS NOT NULL'
      ).all(cleanRunId) as { transaction_id: string }[];

      let itemTxnRows: { transaction_id: string }[] = [];
      try {
        itemTxnRows = this.db.prepare(
          'SELECT DISTINCT transaction_id FROM reconciliation_run_items WHERE run_id = ? AND transaction_id IS NOT NULL'
        ).all(cleanRunId) as { transaction_id: string }[];
      } catch (e) {}

      const txnIds = Array.from(new Set([
        ...runTxnRows.map(r => r.transaction_id),
        ...itemTxnRows.map(r => r.transaction_id)
      ]));

      if (txnIds.length > 0) {
        const placeholders = txnIds.map(() => '?').join(',');
        const rawTxns = this.db.prepare(`SELECT * FROM transactions WHERE transaction_id IN (${placeholders})`).all(...txnIds) as Transaction[];

        // ── Point-in-time recalculation ──────────────────────────────────────
        // When viewing a specific run, recalculate each transaction's settlement
        // status using ONLY the settlements processed up to (<=) this run's
        // created_at. This way Part-1 alone shows PARTIAL even after Part-2 is
        // later ingested and turns the live status to FULLY_SETTLED.
        const runCreatedAt: string = runRecord?.created_at ?? '9999-12-31';

        allTxns = rawTxns.map(txn => {
          // Fetch all settlement records for this txn that were processed in
          // runs created AT OR BEFORE the selected run.
          const history = this.db.prepare(`
            SELECT sh.settlement_amount, sh.settlement_type
            FROM   settlement_history sh
            JOIN   reconciliation_runs rr ON sh.run_id = rr.run_id
            WHERE  sh.transaction_id = ?
              AND  rr.created_at <= ?
          `).all(txn.transaction_id, runCreatedAt) as { settlement_amount: number; settlement_type: string }[];

          if (txn.status === 'FAILED' || txn.status === 'DECLINED') {
            return { ...txn, settlement_status: 'NOT_APPLICABLE', total_settled_amount: 0 };
          }

          if (history.length === 0) {
            return { ...txn, settlement_status: 'PENDING', total_settled_amount: 0 };
          }

          let netCents = 0;
          let hasRefund = false;
          for (const h of history) {
            const c = Math.round(h.settlement_amount * 100);
            if (h.settlement_type === 'DEBIT') { netCents += c; }
            else { netCents -= c; hasRefund = true; }
          }

          const txnCents  = Math.round(txn.transaction_amount * 100);
          const netAmount = netCents / 100;

          let status: SettlementStatus;
          if (hasRefund && netCents < txnCents)    { status = 'REFUNDED'; }
          else if (netCents > txnCents)             { status = 'OVER_SETTLED'; }
          else if (netCents === txnCents)           { status = 'FULLY_SETTLED'; }
          else                                      { status = 'PARTIAL'; }

          return { ...txn, settlement_status: status, total_settled_amount: netAmount };
        });
        // ─────────────────────────────────────────────────────────────────────
      } else {
        allTxns = [];
      }

      const countRow = this.db.prepare('SELECT COUNT(*) as count FROM settlement_history WHERE run_id = ?').get(cleanRunId) as { count: number };
      totalSettlementRecords = countRow?.count || 0;
    } else {
      allTxns = this.db.prepare('SELECT * FROM transactions').all() as Transaction[];
      const countRow = this.db.prepare('SELECT COUNT(*) as count FROM settlement_history').get() as { count: number };
      totalSettlementRecords = countRow?.count || 0;
    }

    // Determine evaluation date: if not provided or empty, find latest settlement or transaction date
    let evalDate: string;
    if (evaluationDate && evaluationDate.trim() !== '') {
      evalDate = evaluationDate.trim();
    } else if (cleanRunId) {
      const maxSettleRow = this.db.prepare(
        'SELECT MAX(settlement_date) as maxDate FROM settlement_history WHERE run_id = ?'
      ).get(cleanRunId) as { maxDate: string | null };
      evalDate = maxSettleRow?.maxDate || (runRecord?.created_at ? runRecord.created_at.split(' ')[0] : '2026-10-13') || '2025-08-15';
    } else {
      const maxSettleRow = this.db.prepare(
        'SELECT MAX(settlement_date) as maxDate FROM settlement_history'
      ).get() as { maxDate: string | null };
      const maxTxnRow = this.db.prepare(
        'SELECT MAX(COALESCE(last_settlement_date, transaction_date)) as maxDate FROM transactions'
      ).get() as { maxDate: string | null };
      evalDate = maxSettleRow?.maxDate || maxTxnRow?.maxDate || '2025-08-15';
    }

    const eligibleTxns = allTxns.filter(t => t.status !== 'FAILED' && t.status !== 'DECLINED');

    const statusBreakdown = {
      pending: 0,
      partial: 0,
      fullySettled: 0,
      overSettled: 0,
      refunded: 0,
      notApplicable: 0
    };

    const agingBands = {
      zeroToThreeDays: { count: 0, totalOutstanding: 0 },
      fourToSevenDays: { count: 0, totalOutstanding: 0 },
      overSevenDays: { count: 0, totalOutstanding: 0 }
    };

    let totalOutstandingCents = 0;
    let totalSettledCents = 0;
    let totalExcessCents = 0;
    let criticalCount = 0;
    let warningCount = 0;
    let cleanCount = 0;

    let totalDaysToSettle = 0;
    let settledTxnCountForAvg = 0;

    const evalDateObj = new Date(evalDate);

    // Calculate run-scoped net settled volume if filtered by run
    if (cleanRunId) {
      const settleRows = this.db.prepare(
        'SELECT settlement_amount, settlement_type FROM settlement_history WHERE run_id = ?'
      ).all(cleanRunId) as { settlement_amount: number; settlement_type: string }[];
      for (const s of settleRows) {
        const sCents = toCents(s.settlement_amount);
        if (s.settlement_type === 'DEBIT') {
          totalSettledCents += sCents;
        } else {
          totalSettledCents -= sCents;
        }
      }
    }

    for (const txn of allTxns) {
      const evaluated = this.issueService.evaluateTransaction(txn, evalDate);

      // Status breakdown
      switch (txn.settlement_status) {
        case 'PENDING':
          statusBreakdown.pending++;
          break;
        case 'PARTIAL':
          statusBreakdown.partial++;
          break;
        case 'FULLY_SETTLED':
          statusBreakdown.fullySettled++;
          break;
        case 'OVER_SETTLED':
          statusBreakdown.overSettled++;
          break;
        case 'REFUNDED':
          statusBreakdown.refunded++;
          break;
        default:
          statusBreakdown.notApplicable++;
      }

      if (evaluated.primary_issue_severity === 'CRITICAL') {
        criticalCount++;
      } else if (evaluated.primary_issue_severity === 'WARNING') {
        warningCount++;
      } else {
        cleanCount++;
      }

      if (txn.status !== 'FAILED' && txn.status !== 'DECLINED') {
        const outCents = toCents(evaluated.outstanding_amount);
        totalOutstandingCents += outCents;
        if (!cleanRunId) {
          totalSettledCents += toCents(txn.total_settled_amount);
        }

        // Aging classification for transactions with outstanding amount
        if (outCents > 0) {
          const refDate = (txn.settlement_status === 'PARTIAL' && txn.last_settlement_date)
            ? txn.last_settlement_date
            : txn.transaction_date;
          const refDateObj = new Date(refDate);
          const diffDays = Math.max(0, Math.floor((evalDateObj.getTime() - refDateObj.getTime()) / (1000 * 60 * 60 * 24)));

          if (diffDays <= 3) {
            agingBands.zeroToThreeDays.count++;
            agingBands.zeroToThreeDays.totalOutstanding = fromCents(
              toCents(agingBands.zeroToThreeDays.totalOutstanding) + outCents
            );
          } else if (diffDays <= 7) {
            agingBands.fourToSevenDays.count++;
            agingBands.fourToSevenDays.totalOutstanding = fromCents(
              toCents(agingBands.fourToSevenDays.totalOutstanding) + outCents
            );
          } else {
            agingBands.overSevenDays.count++;
            agingBands.overSevenDays.totalOutstanding = fromCents(
              toCents(agingBands.overSevenDays.totalOutstanding) + outCents
            );
          }
        }

        // Excess calculation for over-settled
        if (txn.settlement_status === 'OVER_SETTLED') {
          totalExcessCents += Math.max(0, toCents(txn.total_settled_amount) - toCents(txn.transaction_amount));
        }

        // Average settlement time calculation:
        if (txn.settlement_status === 'FULLY_SETTLED' && txn.last_settlement_date) {
          const tDate = new Date(txn.transaction_date).getTime();
          const sDate = new Date(txn.last_settlement_date).getTime();
          const days = Math.max(0, Math.round((sDate - tDate) / (1000 * 60 * 60 * 24)));
          totalDaysToSettle += days;
          settledTxnCountForAvg++;
        }
      }
    }

    const avgDays = settledTxnCountForAvg > 0
      ? parseFloat((totalDaysToSettle / settledTxnCountForAvg).toFixed(1))
      : 0;

    const settlementRate = eligibleTxns.length > 0
      ? parseFloat(((statusBreakdown.fullySettled / eligibleTxns.length) * 100).toFixed(1))
      : 0;

    let totalRuns = 0;
    try {
      const runRow = this.db.prepare('SELECT COUNT(*) as count FROM reconciliation_runs').get() as { count: number };
      totalRuns = runRow?.count || 0;
    } catch (e) {}

    let unmatchedSettlementCount = 0;
    try {
      if (cleanRunId) {
        const unmatchedRow = this.db.prepare(
          "SELECT COUNT(*) as count FROM reconciliation_run_items WHERE run_id = ? AND item_type IN ('UNMATCHED', 'AMBIGUOUS', 'INVALID', 'CONFLICT')"
        ).get(cleanRunId) as { count: number };
        unmatchedSettlementCount = unmatchedRow?.count || 0;
      } else {
        const unmatchedRow = this.db.prepare(
          "SELECT COUNT(*) as count FROM reconciliation_run_items WHERE item_type IN ('UNMATCHED', 'AMBIGUOUS')"
        ).get() as { count: number };
        unmatchedSettlementCount = unmatchedRow?.count || 0;
      }
    } catch (e) {}

    return {
      totalTransactions: allTxns.length,
      eligibleTransactions: eligibleTxns.length,
      totalSettlementRecords,
      statusBreakdown,
      issueBreakdown: {
        criticalCount,
        warningCount,
        cleanCount
      },
      agingBands,
      totalOutstandingAmount: fromCents(totalOutstandingCents),
      totalSettledAmount: fromCents(totalSettledCents),
      totalExcessAmount: fromCents(totalExcessCents),
      averageDaysToSettle: avgDays,
      settlementRate,
      latestDate: evalDate,
      totalRuns,
      unmatchedSettlementCount,
      activeRunId: cleanRunId,
      runDetails: runRecord || null
    };
  }
}
