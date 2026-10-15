import Database from 'better-sqlite3';
import {
  ExceptionItem,
  ExceptionReview,
  ExceptionReviewStatus,
  IssueSeverity,
  SettlementHistory,
  Transaction
} from '../types/index.js';
import { IssueDetectionService } from './issue-detection.service.js';
import { formatMoney, fromCents, toCents } from '../utils/money.js';

export class ExceptionService {
  private issueService: IssueDetectionService;
  private stmtGetReview: Database.Statement;
  private stmtUpsertReview: Database.Statement;

  constructor(private db: Database.Database) {
    this.issueService = new IssueDetectionService();

    this.stmtGetReview = this.db.prepare(
      'SELECT * FROM exception_reviews WHERE exception_id = ?'
    );

    this.stmtUpsertReview = this.db.prepare(
      `INSERT INTO exception_reviews (
        exception_id, transaction_id, issue_code, severity, review_status, notes, reviewed_by, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(exception_id) DO UPDATE SET
        review_status = excluded.review_status,
        notes = excluded.notes,
        reviewed_by = excluded.reviewed_by,
        updated_at = CURRENT_TIMESTAMP`
    );
  }

  public getExceptions(options?: {
    severity?: string;
    reviewStatus?: string;
    issueType?: string;
    search?: string;
    evaluationDate?: string;
  }): { total: number; exceptions: ExceptionItem[] } {
    const evalDate = options?.evaluationDate || '2025-08-15';
    const txns = this.db.prepare('SELECT * FROM transactions').all() as Transaction[];

    const exceptions: ExceptionItem[] = [];

    // 1. Transaction-level discrepancies
    for (const txn of txns) {
      if (txn.status === 'FAILED' || txn.status === 'DECLINED') continue;

      const evaluated = this.issueService.evaluateTransaction(txn, evalDate);

      for (const issue of evaluated.issues) {
        const exceptionId = `EXP_TXN_${issue.code}_${txn.transaction_id}`;
        const review = this.stmtGetReview.get(exceptionId) as ExceptionReview | undefined;

        const settlements = this.db.prepare(
          'SELECT COUNT(*) as count FROM settlement_history WHERE transaction_id = ?'
        ).get(txn.transaction_id) as { count: number };

        const diffAmount = issue.code === 'OVER_SETTLED_CRITICAL'
          ? fromCents(Math.max(toCents(txn.total_settled_amount) - toCents(txn.transaction_amount), 0))
          : evaluated.outstanding_amount;

        exceptions.push({
          exception_id: exceptionId,
          transaction_id: txn.transaction_id,
          merchant_name: txn.merchant_name,
          issue_type: issue.code,
          severity: issue.severity,
          expected_amount: txn.transaction_amount,
          net_settled_amount: txn.total_settled_amount,
          difference_amount: diffAmount,
          detection_date: txn.last_settlement_date || txn.transaction_date,
          review_status: review ? review.review_status : 'UNREVIEWED',
          notes: review ? review.notes : null,
          recommendation: issue.recommendation,
          description: issue.description,
          settlement_count: settlements.count
        });
      }
    }

    // 2. Run-level discrepancies (Unmatched, Ambiguous, Conflicts from reconciliation runs)
    const runItems = this.db.prepare(
      `SELECT r.run_id, r.created_at, i.id, i.row_number, i.settlement_id, i.item_type, i.reason, i.raw_data
       FROM reconciliation_run_items i
       JOIN reconciliation_runs r ON i.run_id = r.run_id
       WHERE i.item_type IN ('UNMATCHED', 'AMBIGUOUS', 'CONFLICT', 'INVALID')
       ORDER BY i.id DESC`
    ).all() as any[];

    for (const item of runItems) {
      const exceptionId = `EXP_RUN_${item.item_type}_${item.id}`;
      const review = this.stmtGetReview.get(exceptionId) as ExceptionReview | undefined;

      let rawObj: any = {};
      try {
        if (item.raw_data) rawObj = JSON.parse(item.raw_data);
      } catch (e) {
        // ignore
      }

      const amount = parseFloat(rawObj.settlement_amount) || 0;
      const severity: IssueSeverity = (item.item_type === 'CONFLICT' || item.item_type === 'INVALID')
        ? 'CRITICAL'
        : 'WARNING';

      exceptions.push({
        exception_id: exceptionId,
        transaction_id: null,
        merchant_name: rawObj.merchant_name || 'N/A',
        issue_type: `RUN_${item.item_type}`,
        severity,
        expected_amount: amount,
        net_settled_amount: 0,
        difference_amount: amount,
        detection_date: (item.created_at || '').substring(0, 10) || evalDate,
        review_status: review ? review.review_status : 'UNREVIEWED',
        notes: review ? review.notes : null,
        recommendation: item.item_type === 'CONFLICT'
          ? 'Investigate conflicting batch record with payment acquirer.'
          : item.item_type === 'AMBIGUOUS'
          ? 'Manually link settlement to correct ledger account using unique identifiers.'
          : 'Review unlinked processor settlement batch tranche.',
        description: item.reason || `${item.item_type} record encountered during import ${item.run_id}`,
        matching_method: 'RUN_AUDIT',
        settlement_count: 1
      });
    }

    // Apply Filters
    let filtered = exceptions;

    if (options?.severity && options.severity !== 'ALL') {
      filtered = filtered.filter(e => e.severity === options.severity);
    }

    if (options?.reviewStatus && options.reviewStatus !== 'ALL') {
      filtered = filtered.filter(e => e.review_status === options.reviewStatus);
    }

    if (options?.issueType && options.issueType !== 'ALL') {
      filtered = filtered.filter(e => e.issue_type === options.issueType);
    }

    if (options?.search && options.search.trim().length > 0) {
      const q = options.search.trim().toLowerCase();
      filtered = filtered.filter(e =>
        e.exception_id.toLowerCase().includes(q) ||
        (e.transaction_id && e.transaction_id.toLowerCase().includes(q)) ||
        e.merchant_name.toLowerCase().includes(q) ||
        e.issue_type.toLowerCase().includes(q)
      );
    }

    return { total: filtered.length, exceptions: filtered };
  }

  public getExceptionById(exceptionId: string): any {
    const all = this.getExceptions().exceptions;
    const item = all.find(e => e.exception_id === exceptionId);
    if (!item) return null;

    let transactionDetails: Transaction | null = null;
    let settlements: SettlementHistory[] = [];

    if (item.transaction_id) {
      transactionDetails = this.db.prepare(
        'SELECT * FROM transactions WHERE transaction_id = ?'
      ).get(item.transaction_id) as Transaction | null;

      settlements = this.db.prepare(
        'SELECT * FROM settlement_history WHERE transaction_id = ? ORDER BY settlement_date ASC'
      ).all(item.transaction_id) as SettlementHistory[];
    }

    const review = this.stmtGetReview.get(exceptionId) as ExceptionReview | undefined;

    return {
      exception: item,
      review: review || {
        exception_id: exceptionId,
        review_status: 'UNREVIEWED',
        notes: null,
        reviewed_by: 'Demo Analyst',
        updated_at: new Date().toISOString()
      },
      transaction: transactionDetails,
      settlements,
      explanation: {
        financialFormula: 'Net Settled Amount = Sum(DEBIT Settlements) - Sum(CREDIT Settlements)',
        ruleTriggered: item.issue_type,
        diagnosis: item.description,
        recommendedAction: item.recommendation
      }
    };
  }

  public updateReview(
    exceptionId: string,
    data: {
      reviewStatus: ExceptionReviewStatus;
      notes?: string;
      reviewedBy?: string;
    }
  ): ExceptionReview {
    const all = this.getExceptions().exceptions;
    const item = all.find(e => e.exception_id === exceptionId);

    const txnId = item?.transaction_id || null;
    const issueCode = item?.issue_type || 'GENERAL_EXCEPTION';
    const severity = item?.severity || 'WARNING';

    this.stmtUpsertReview.run(
      exceptionId,
      txnId,
      issueCode,
      severity,
      data.reviewStatus,
      data.notes || null,
      data.reviewedBy || 'Ops Analyst'
    );

    return this.stmtGetReview.get(exceptionId) as ExceptionReview;
  }

  public exportExceptionsCSV(options?: {
    severity?: string;
    reviewStatus?: string;
    search?: string;
  }): string {
    const list = this.getExceptions(options).exceptions;
    const headers = [
      'exception_id',
      'transaction_id',
      'merchant_name',
      'issue_type',
      'severity',
      'expected_amount',
      'net_settled_amount',
      'difference_amount',
      'detection_date',
      'review_status',
      'notes',
      'recommendation'
    ];

    const rows = list.map(e => {
      let sevBadge: string = e.severity;
      if (e.severity === 'CRITICAL') sevBadge = '🔴 CRITICAL';
      else if (e.severity === 'WARNING') sevBadge = '🟡 WARNING';

      let statusBadge: string = e.review_status;
      if (e.review_status === 'RESOLVED') statusBadge = '🟢 RESOLVED';
      else if (e.review_status === 'UNDER_REVIEW') statusBadge = '🟡 UNDER_REVIEW';
      else if (e.review_status === 'UNREVIEWED') statusBadge = '⚪ UNREVIEWED';

      return [
        e.exception_id,
        e.transaction_id || '',
        `"${e.merchant_name.replace(/"/g, '""')}"`,
        e.issue_type,
        `"${sevBadge}"`,
        formatMoney(e.expected_amount),
        formatMoney(e.net_settled_amount),
        formatMoney(e.difference_amount),
        e.detection_date,
        `"${statusBadge}"`,
        `"${(e.notes || '').replace(/"/g, '""')}"`,
        `"${e.recommendation.replace(/"/g, '""')}"`
      ];
    });

    return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  }
}
