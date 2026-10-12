import { Request, Response } from 'express';
import { getDatabase } from '../db/index.js';
import { IssueDetectionService } from '../services/issue-detection.service.js';
import { SettlementHistory, Transaction } from '../types/index.js';
import { config } from '../config/index.js';

export class TransactionController {
  public static async getAll(req: Request, res: Response): Promise<void> {
    try {
      const db = getDatabase();
      const issueService = new IssueDetectionService();

      const evaluationDate = (req.query.evaluationDate as string) || config.defaultEvaluationDate;
      const statusFilter = req.query.status as string;
      const severityFilter = req.query.severity as string;
      const searchQuery = (req.query.search as string || '').toLowerCase().trim();

      const allTxns = db.prepare('SELECT * FROM transactions ORDER BY transaction_date DESC, transaction_id ASC').all() as Transaction[];

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
      const evaluationDate = (req.query.evaluationDate as string) || config.defaultEvaluationDate;

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

      // Build Chronological Timeline
      const timeline: Array<{
        date: string;
        type: 'TRANSACTION_INITIATED' | 'SETTLEMENT_DEBIT' | 'SETTLEMENT_CREDIT' | 'RECONCILED';
        title: string;
        description: string;
        amount?: number;
      }> = [
        {
          date: txn.transaction_date,
          type: 'TRANSACTION_INITIATED',
          title: `Transaction Created (${txn.status})`,
          description: `${txn.merchant_name} purchase on account ${txn.account_id}`,
          amount: txn.transaction_amount
        }
      ];

      settlements.forEach(s => {
        timeline.push({
          date: s.settlement_date,
          type: s.settlement_type === 'DEBIT' ? 'SETTLEMENT_DEBIT' : 'SETTLEMENT_CREDIT',
          title: `${s.settlement_type} Settlement Received [${s.settlement_id}]`,
          description: `Processed ${s.currency} ${s.settlement_amount} via ${s.lifecycle_id || 'Fallback Matching'}`,
          amount: s.settlement_amount
        });
      });

      if (txn.settlement_status !== 'PENDING') {
        timeline.push({
          date: txn.last_settlement_date || txn.transaction_date,
          type: 'RECONCILED',
          title: `Status: ${txn.settlement_status}`,
          description: `Total Net Settled: $${txn.total_settled_amount.toFixed(2)} | Outstanding: $${evaluated.outstanding_amount.toFixed(2)}`
        });
      }

      timeline.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      res.status(200).json({
        success: true,
        data: {
          ...evaluated,
          settlements,
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
      const allTxns = db.prepare('SELECT * FROM transactions ORDER BY transaction_date ASC').all() as Transaction[];
      const evaluated = allTxns.map(t => issueService.evaluateTransaction(t, config.defaultEvaluationDate));

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
          `"${t.merchant_name}"`,
          t.transaction_date,
          t.transaction_amount.toFixed(2),
          t.currency,
          t.status,
          t.settlement_status,
          t.total_settled_amount.toFixed(2),
          t.outstanding_amount.toFixed(2),
          t.primary_issue_severity,
          t.issues.length
        ];
        csvRows.push(row.join(','));
      });

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="reconciled_transactions.csv"');
      res.status(200).send(csvRows.join('\n'));
    } catch (err: any) {
      console.error('Export CSV error:', err);
      res.status(500).json({ success: false, error: 'Failed to export CSV' });
    }
  }
}
