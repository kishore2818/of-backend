import { Request, Response } from 'express';
import { getDatabase } from '../db/index.js';
import { IssueDetectionService } from '../services/issue-detection.service.js';
import { SettlementHistory, Transaction } from '../types/index.js';
import { toCents, fromCents, formatMoney } from '../utils/money.js';

function getStatusDefinition(status: string): string {
  switch (status) {
    case 'PENDING':
      return 'No valid settlement records exist yet for this transaction.';
    case 'PARTIAL':
      return 'Net settled amount is below the original transaction amount without a qualifying refund status.';
    case 'FULLY_SETTLED':
      return 'Net settled amount exactly matches the transaction amount.';
    case 'OVER_SETTLED':
      return 'Net settled amount exceeds original transaction amount. Potential duplicate debit or overpayment.';
    case 'REFUNDED':
      return 'A qualifying refund (credit settlement) has reduced the net settled amount below original value.';
    case 'NOT_APPLICABLE':
      return 'Transaction failed or was declined at processing; excluded from settlement matching.';
    default:
      return 'Unknown status';
  }
}

export class TransactionController {
  public static async getAll(req: Request, res: Response): Promise<void> {
    try {
      const db = getDatabase();
      const issueService = new IssueDetectionService();

      const rawDate = req.query.evaluationDate as string;
      let evaluationDate = (rawDate && rawDate.trim() !== '') ? rawDate.trim() : undefined;
      if (!evaluationDate) {
        const maxSettleRow = db.prepare('SELECT MAX(settlement_date) as maxDate FROM settlement_history').get() as { maxDate: string | null };
        const maxTxnRow = db.prepare('SELECT MAX(COALESCE(last_settlement_date, transaction_date)) as maxDate FROM transactions').get() as { maxDate: string | null };
        evaluationDate = maxSettleRow?.maxDate || maxTxnRow?.maxDate || '2025-08-15';
      }

      const statusFilter = req.query.status as string;
      const severityFilter = req.query.severity as string;
      const searchQuery = (req.query.search as string || '').toLowerCase().trim();
      const rawRunId = req.query.runId as string | undefined;
      const cleanRunId = (rawRunId && rawRunId.trim() !== '' && rawRunId !== 'ALL') ? rawRunId.trim() : null;

      let allTxns: Transaction[];
      if (cleanRunId) {
        const runTxnRows = db.prepare(
          'SELECT DISTINCT transaction_id FROM settlement_history WHERE run_id = ? AND transaction_id IS NOT NULL'
        ).all(cleanRunId) as { transaction_id: string }[];

        let itemTxnRows: { transaction_id: string }[] = [];
        try {
          itemTxnRows = db.prepare(
            'SELECT DISTINCT transaction_id FROM reconciliation_run_items WHERE run_id = ? AND transaction_id IS NOT NULL'
          ).all(cleanRunId) as { transaction_id: string }[];
        } catch (e) {}

        const txnIds = Array.from(new Set([
          ...runTxnRows.map(r => r.transaction_id),
          ...itemTxnRows.map(r => r.transaction_id)
        ]));

        if (txnIds.length > 0) {
          const placeholders = txnIds.map(() => '?').join(',');
          allTxns = db.prepare(
            `SELECT * FROM transactions WHERE transaction_id IN (${placeholders}) ORDER BY COALESCE(last_settlement_date, transaction_date) DESC, transaction_date DESC, transaction_id ASC`
          ).all(...txnIds) as Transaction[];
        } else {
          allTxns = [];
        }
      } else {
        allTxns = db.prepare(
          'SELECT * FROM transactions ORDER BY COALESCE(last_settlement_date, transaction_date) DESC, transaction_date DESC, transaction_id ASC'
        ).all() as Transaction[];
      }

      let results = allTxns.map(t => issueService.evaluateTransaction(t, evaluationDate));

      if (statusFilter && statusFilter !== 'ALL') {
        results = results.filter(t => t.settlement_status === statusFilter);
      }

      if (severityFilter && severityFilter !== 'ALL') {
        results = results.filter(t => t.primary_issue_severity === severityFilter);
      }

      if (searchQuery) {
        results = results.filter(t =>
          t.transaction_id.toLowerCase().includes(searchQuery) ||
          t.merchant_name.toLowerCase().includes(searchQuery) ||
          t.account_id.toLowerCase().includes(searchQuery) ||
          (t.lifecycle_id && t.lifecycle_id.toLowerCase().includes(searchQuery))
        );
      }

      res.status(200).json({
        success: true,
        total: results.length,
        evaluationDate,
        data: results
      });
    } catch (err: any) {
      console.error('Fetch transactions error:', err);
      res.status(500).json({
        success: false,
        error: `Failed to fetch transactions: ${err.message}`
      });
    }
  }

  public static async getById(req: Request, res: Response): Promise<void> {
    try {
      const db = getDatabase();
      const issueService = new IssueDetectionService();
      const transactionId = req.params.id;
      const rawDate = req.query.evaluationDate as string;
      let evaluationDate = (rawDate && rawDate.trim() !== '') ? rawDate.trim() : undefined;
      if (!evaluationDate) {
        const maxSettleRow = db.prepare('SELECT MAX(settlement_date) as maxDate FROM settlement_history').get() as { maxDate: string | null };
        const maxTxnRow = db.prepare('SELECT MAX(COALESCE(last_settlement_date, transaction_date)) as maxDate FROM transactions').get() as { maxDate: string | null };
        evaluationDate = maxSettleRow?.maxDate || maxTxnRow?.maxDate || '2025-08-15';
      }

      const txn = db.prepare<[string]>('SELECT * FROM transactions WHERE transaction_id = ?').get(transactionId) as Transaction | undefined;

      if (!txn) {
        res.status(404).json({
          success: false,
          error: `Transaction with ID "${transactionId}" not found.`
        });
        return;
      }

      const settlements = db.prepare<[string]>(
        'SELECT * FROM settlement_history WHERE transaction_id = ? ORDER BY settlement_date ASC, processed_at ASC'
      ).all(transactionId) as SettlementHistory[];

      const evaluated = issueService.evaluateTransaction(txn, evaluationDate);

      // Financial Calculation breakdown
      let totalDebitsCents = 0;
      let totalCreditsCents = 0;
      let runningCents = 0;

      const enrichedSettlements = settlements.map(s => {
        const sCents = toCents(s.settlement_amount);
        if (s.settlement_type === 'DEBIT') {
          totalDebitsCents += sCents;
          runningCents += sCents;
        } else {
          totalCreditsCents += sCents;
          runningCents -= sCents;
        }

        const matchMethod = s.match_method || (s.lifecycle_id ? 'PRIMARY_LIFECYCLE' : 'FALLBACK_COMPOSITE');
        const matchExplanation = matchMethod === 'PRIMARY_LIFECYCLE'
          ? `Matched via Primary Lifecycle ID: ${s.lifecycle_id || txn.lifecycle_id}`
          : `Matched via Fallback Composite: Account ${txn.account_id} + Merchant "${txn.merchant_name}" + Date ${txn.transaction_date}`;

        return {
          ...s,
          running_net_settled: fromCents(runningCents),
          match_method: matchMethod,
          match_explanation: matchExplanation
        };
      });

      const financialExplanation = {
        transaction_amount: txn.transaction_amount,
        total_debit_amount: fromCents(totalDebitsCents),
        total_credit_amount: fromCents(totalCreditsCents),
        net_settled_amount: txn.total_settled_amount,
        outstanding_amount: evaluated.outstanding_amount,
        excess_amount: fromCents(Math.max(0, toCents(txn.total_settled_amount) - toCents(txn.transaction_amount))),
        settlement_status: txn.settlement_status,
        formula: 'Net Settled Amount = Total Debits - Total Credits',
        status_definition: getStatusDefinition(txn.settlement_status)
      };

      // Build Chronological Timeline
      const timeline: Array<{
        date: string;
        type: 'TRANSACTION_INITIATED' | 'SETTLEMENT_DEBIT' | 'SETTLEMENT_CREDIT' | 'RECONCILED' | 'ISSUE_DETECTED';
        title: string;
        description: string;
        amount?: number;
        running_net?: number;
        settlement_id?: string;
        run_id?: string | null;
      }> = [
        {
          date: txn.transaction_date,
          type: 'TRANSACTION_INITIATED',
          title: `Transaction Created (${txn.status})`,
          description: `${txn.merchant_name} purchase on account ${txn.account_id} for $${formatMoney(txn.transaction_amount)}`,
          amount: txn.transaction_amount,
          running_net: 0
        }
      ];

      enrichedSettlements.forEach(s => {
        timeline.push({
          date: s.settlement_date,
          type: s.settlement_type === 'DEBIT' ? 'SETTLEMENT_DEBIT' : 'SETTLEMENT_CREDIT',
          title: `${s.settlement_type} Settlement Received [${s.settlement_id}]`,
          description: `${s.currency} ${formatMoney(s.settlement_amount)} via ${s.match_method === 'PRIMARY_LIFECYCLE' ? 'Lifecycle ID' : 'Fallback Composite'}. Running Net: $${formatMoney(s.running_net_settled)}`,
          amount: s.settlement_amount,
          running_net: s.running_net_settled,
          settlement_id: s.settlement_id,
          run_id: s.run_id
        });
      });

      if (evaluated.issues.length > 0) {
        evaluated.issues.forEach(iss => {
          timeline.push({
            date: evaluationDate,
            type: 'ISSUE_DETECTED',
            title: `Issue Flagged: ${iss.code} (${iss.severity})`,
            description: iss.description
          });
        });
      }

      if (txn.settlement_status !== 'PENDING') {
        timeline.push({
          date: txn.last_settlement_date || txn.transaction_date,
          type: 'RECONCILED',
          title: `Current State: ${txn.settlement_status}`,
          description: `Total Net Settled: $${formatMoney(txn.total_settled_amount)} | Outstanding: $${formatMoney(evaluated.outstanding_amount)}`
        });
      }

      timeline.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      res.status(200).json({
        success: true,
        data: {
          ...evaluated,
          settlements: enrichedSettlements,
          financialExplanation,
          timeline
        }
      });
    } catch (err: any) {
      console.error('Fetch transaction by id error:', err);
      res.status(500).json({
        success: false,
        error: `Failed to fetch transaction details: ${err.message}`
      });
    }
  }

  public static async exportCsv(req: Request, res: Response): Promise<void> {
    try {
      const db = getDatabase();
      const issueService = new IssueDetectionService();

      const rawDate = req.query.evaluationDate as string;
      let evaluationDate = (rawDate && rawDate.trim() !== '') ? rawDate.trim() : undefined;
      if (!evaluationDate) {
        const maxSettleRow = db.prepare('SELECT MAX(settlement_date) as maxDate FROM settlement_history').get() as { maxDate: string | null };
        const maxTxnRow = db.prepare('SELECT MAX(COALESCE(last_settlement_date, transaction_date)) as maxDate FROM transactions').get() as { maxDate: string | null };
        evaluationDate = maxSettleRow?.maxDate || maxTxnRow?.maxDate || '2025-08-15';
      }

      const statusFilter = req.query.status as string;
      const severityFilter = req.query.severity as string;
      const searchQuery = (req.query.search as string || '').toLowerCase().trim();
      const rawRunId = req.query.runId as string | undefined;
      const cleanRunId = (rawRunId && rawRunId.trim() !== '' && rawRunId !== 'ALL') ? rawRunId.trim() : null;

      let allTxns: Transaction[];
      if (cleanRunId) {
        const runTxnRows = db.prepare(
          'SELECT DISTINCT transaction_id FROM settlement_history WHERE run_id = ? AND transaction_id IS NOT NULL'
        ).all(cleanRunId) as { transaction_id: string }[];

        let itemTxnRows: { transaction_id: string }[] = [];
        try {
          itemTxnRows = db.prepare(
            'SELECT DISTINCT transaction_id FROM reconciliation_run_items WHERE run_id = ? AND transaction_id IS NOT NULL'
          ).all(cleanRunId) as { transaction_id: string }[];
        } catch (e) {}

        const txnIds = Array.from(new Set([
          ...runTxnRows.map(r => r.transaction_id),
          ...itemTxnRows.map(r => r.transaction_id)
        ]));

        if (txnIds.length > 0) {
          const placeholders = txnIds.map(() => '?').join(',');
          allTxns = db.prepare(
            `SELECT * FROM transactions WHERE transaction_id IN (${placeholders}) ORDER BY transaction_date ASC`
          ).all(...txnIds) as Transaction[];
        } else {
          allTxns = [];
        }
      } else {
        allTxns = db.prepare('SELECT * FROM transactions ORDER BY transaction_date ASC').all() as Transaction[];
      }
      let evaluated = allTxns.map(t => issueService.evaluateTransaction(t, evaluationDate));

      if (statusFilter && statusFilter !== 'ALL') {
        evaluated = evaluated.filter(t => t.settlement_status === statusFilter);
      }

      if (severityFilter && severityFilter !== 'ALL') {
        evaluated = evaluated.filter(t => t.primary_issue_severity === severityFilter);
      }

      if (searchQuery) {
        evaluated = evaluated.filter(t =>
          t.transaction_id.toLowerCase().includes(searchQuery) ||
          t.merchant_name.toLowerCase().includes(searchQuery) ||
          t.account_id.toLowerCase().includes(searchQuery) ||
          (t.lifecycle_id && t.lifecycle_id.toLowerCase().includes(searchQuery))
        );
      }

      const headers = [
        'transaction_id',
        'lifecycle_id',
        'account_id',
        'merchant_name',
        'transaction_date',
        'transaction_amount',
        'currency',
        'status',
        'settlement_status',
        'total_settled_amount',
        'outstanding_amount',
        'issue_severity',
        'issues_count'
      ];

      const csvRows = [headers.join(',')];
      evaluated.forEach(t => {
        const row = [
          t.transaction_id,
          t.lifecycle_id || '',
          t.account_id,
          `"${t.merchant_name.replace(/"/g, '""')}"`,
          t.transaction_date,
          formatMoney(t.transaction_amount),
          t.currency,
          t.status,
          t.settlement_status,
          formatMoney(t.total_settled_amount),
          formatMoney(t.outstanding_amount),
          t.primary_issue_severity,
          t.issues.length
        ];
        csvRows.push(row.join(','));
      });

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="filtered_transactions.csv"');
      res.status(200).send(csvRows.join('\n'));
    } catch (err: any) {
      console.error('Export CSV error:', err);
      res.status(500).json({ success: false, error: 'Failed to export CSV' });
    }
  }

  public static async exportTransactionSettlements(req: Request, res: Response): Promise<void> {
    try {
      const db = getDatabase();
      const transactionId = req.params.id;

      const settlements = db.prepare(
        'SELECT * FROM settlement_history WHERE transaction_id = ? ORDER BY settlement_date ASC'
      ).all(transactionId) as SettlementHistory[];

      const headers = [
        'settlement_id',
        'transaction_id',
        'lifecycle_id',
        'settlement_date',
        'settlement_amount',
        'settlement_type',
        'currency',
        'match_method',
        'run_id',
        'processed_at'
      ];

      const csvRows = [headers.join(',')];
      settlements.forEach(s => {
        const row = [
          s.settlement_id,
          s.transaction_id || '',
          s.lifecycle_id || '',
          s.settlement_date,
          formatMoney(s.settlement_amount),
          s.settlement_type,
          s.currency,
          s.match_method || '',
          s.run_id || '',
          s.processed_at || ''
        ];
        csvRows.push(row.join(','));
      });

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="transaction_${transactionId}_settlements.csv"`);
      res.status(200).send(csvRows.join('\n'));
    } catch (err: any) {
      console.error('Export transaction settlements error:', err);
      res.status(500).json({ success: false, error: 'Failed to export settlement history CSV' });
    }
  }

  public static async getAllSettlements(req: Request, res: Response): Promise<void> {
    try {
      const db = getDatabase();
      const rawRunId = req.query.runId as string | undefined;
      const cleanRunId = (rawRunId && rawRunId.trim() !== '' && rawRunId !== 'ALL') ? rawRunId.trim() : null;

      let settlements: SettlementHistory[];
      if (cleanRunId) {
        settlements = db.prepare(
          'SELECT * FROM settlement_history WHERE run_id = ? ORDER BY settlement_date DESC, processed_at DESC'
        ).all(cleanRunId) as SettlementHistory[];
      } else {
        settlements = db.prepare(
          'SELECT * FROM settlement_history ORDER BY settlement_date DESC, processed_at DESC'
        ).all() as SettlementHistory[];
      }

      res.status(200).json({
        success: true,
        total: settlements.length,
        data: settlements
      });
    } catch (err: any) {
      console.error('Fetch all settlements error:', err);
      res.status(500).json({
        success: false,
        error: `Failed to fetch settlements: ${err.message}`
      });
    }
  }
}
