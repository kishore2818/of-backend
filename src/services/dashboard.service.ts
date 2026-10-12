import Database from 'better-sqlite3';
import { DashboardSummary, Transaction } from '../types/index.js';
import { IssueDetectionService } from './issue-detection.service.js';
import { fromCents, toCents } from '../utils/money.js';

export class DashboardService {
  private issueService: IssueDetectionService;

  constructor(private db: Database.Database) {
    this.issueService = new IssueDetectionService();
  }

  public getSummary(evaluationDate?: string): DashboardSummary {
    const allTxns = this.db.prepare('SELECT * FROM transactions').all() as Transaction[];
    const totalSettlementRecords = (
      this.db.prepare('SELECT COUNT(*) as count FROM settlement_history').get() as { count: number }
    ).count;

    // Determine evaluation date: if not provided, find latest settlement_date or fallback to '2025-08-15'
    let evalDate = evaluationDate;
    if (!evalDate) {
      const maxDateRow = this.db.prepare(
        'SELECT MAX(settlement_date) as maxDate FROM settlement_history'
      ).get() as { maxDate: string | null };
      evalDate = maxDateRow?.maxDate || '2025-08-15';
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

    let totalOutstandingCents = 0;
    let totalSettledCents = 0;
    let criticalCount = 0;
    let warningCount = 0;
    let cleanCount = 0;

    let totalDaysToSettle = 0;
    let settledTxnCountForAvg = 0;

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
        totalOutstandingCents += toCents(evaluated.outstanding_amount);
        totalSettledCents += toCents(txn.total_settled_amount);

        // Average settlement time calculation:
        // When transaction has achieved FULLY_SETTLED and has settlement date
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
      totalOutstandingAmount: fromCents(totalOutstandingCents),
      totalSettledAmount: fromCents(totalSettledCents),
      averageDaysToSettle: avgDays,
      settlementRate
    };
  }
}
