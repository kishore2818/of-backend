import { Request, Response } from 'express';
import { getDatabase } from '../db/index.js';
import { IssueDetectionService } from '../services/issue-detection.service.js';
import { SettlementHistory, Transaction } from '../types/index.js';
import { toCents, fromCents, formatMoney } from '../utils/money.js';
import { SettlementService } from '../services/settlement.service.js';

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

  public static async updateTransaction(req: Request, res: Response): Promise<void> {
    try {
      const db = getDatabase();
      const { id } = req.params;
      const {
        merchant_name,
        transaction_amount,
        currency,
        status,
        lifecycle_id,
        transaction_date
      } = req.body;

      // Verify transaction exists
      const existing = db.prepare('SELECT * FROM transactions WHERE transaction_id = ?').get(id) as Transaction | undefined;
      if (!existing) {
        res.status(404).json({ success: false, error: `Transaction ${id} not found.` });
        return;
      }

      const newMerchant = merchant_name !== undefined ? String(merchant_name).trim() : existing.merchant_name;
      const newAmount = transaction_amount !== undefined ? Number(transaction_amount) : existing.transaction_amount;
      const newCurrency = currency !== undefined ? String(currency).trim().toUpperCase() : existing.currency;
      const newStatus = status !== undefined ? String(status).trim().toUpperCase() : existing.status;
      const newLifecycleId = lifecycle_id !== undefined ? (String(lifecycle_id).trim() || null) : existing.lifecycle_id;
      const newDate = transaction_date !== undefined ? String(transaction_date).trim() : existing.transaction_date;

      if (isNaN(newAmount) || newAmount <= 0) {
        res.status(400).json({ success: false, error: 'Transaction amount must be a positive number.' });
        return;
      }

      // Update primary fields
      db.prepare(`
        UPDATE transactions
        SET merchant_name = ?,
            transaction_amount = ?,
            currency = ?,
            status = ?,
            lifecycle_id = ?,
            transaction_date = ?
        WHERE transaction_id = ?
      `).run(newMerchant, newAmount, newCurrency, newStatus, newLifecycleId, newDate, id);

      // Recalculate settlement status using SettlementService
      const settlementService = new SettlementService(db);
      settlementService.recalculateTransaction(id);

      const updated = db.prepare('SELECT * FROM transactions WHERE transaction_id = ?').get(id) as Transaction;

      res.status(200).json({
        success: true,
        message: `Transaction ${id} updated successfully and settlement status recalculated.`,
        data: updated
      });
    } catch (err: any) {
      console.error('Update transaction error:', err);
      res.status(500).json({
        success: false,
        error: `Failed to update transaction: ${err.message}`
      });
    }
  }

  public static async createTransaction(req: Request, res: Response): Promise<void> {
    try {
      const db = getDatabase();
      const {
        transaction_id,
        account_id,
        merchant_name,
        transaction_amount,
        currency = 'USD',
        status = 'COMPLETED',
        lifecycle_id,
        transaction_date
      } = req.body;

      if (!transaction_id || !String(transaction_id).trim()) {
        res.status(400).json({ success: false, error: 'Transaction ID is required.' });
        return;
      }
      if (!account_id || !String(account_id).trim()) {
        res.status(400).json({ success: false, error: 'Account ID is required.' });
        return;
      }
      if (!merchant_name || !String(merchant_name).trim()) {
        res.status(400).json({ success: false, error: 'Merchant name is required.' });
        return;
      }
      const numAmount = Number(transaction_amount);
      if (isNaN(numAmount) || numAmount <= 0) {
        res.status(400).json({ success: false, error: 'Transaction amount must be a positive number.' });
        return;
      }

      const cleanTxnId = String(transaction_id).trim().toUpperCase();
      const existing = db.prepare('SELECT transaction_id FROM transactions WHERE transaction_id = ?').get(cleanTxnId);
      if (existing) {
        res.status(400).json({ success: false, error: `Transaction ID ${cleanTxnId} already exists.` });
        return;
      }

      const todayStr = new Date().toISOString().split('T')[0];
      const txnDate = transaction_date && String(transaction_date).trim() ? String(transaction_date).trim() : todayStr;
      const cleanLifecycle = lifecycle_id && String(lifecycle_id).trim() ? String(lifecycle_id).trim().toUpperCase() : null;
      const cleanStatus = String(status).trim().toUpperCase();
      const cleanCurrency = String(currency).trim().toUpperCase();
      const cleanAccount = String(account_id).trim().toUpperCase();
      const cleanMerchant = String(merchant_name).trim();

      const initialSettlementStatus = (cleanStatus === 'FAILED' || cleanStatus === 'DECLINED') ? 'NOT_APPLICABLE' : 'PENDING';

      db.prepare(`
        INSERT INTO transactions (
          transaction_id, lifecycle_id, account_id, merchant_name,
          transaction_date, transaction_amount, currency, status,
          settlement_status, total_settled_amount, last_settlement_date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0.00, NULL)
      `).run(
        cleanTxnId,
        cleanLifecycle,
        cleanAccount,
        cleanMerchant,
        txnDate,
        numAmount,
        cleanCurrency,
        cleanStatus,
        initialSettlementStatus
      );

      // In case any settlements previously existed with this lifecycle_id or composite match
      const settlementService = new SettlementService(db);
      settlementService.recalculateTransaction(cleanTxnId);

      const created = db.prepare('SELECT * FROM transactions WHERE transaction_id = ?').get(cleanTxnId) as Transaction;

      res.status(201).json({
        success: true,
        message: `Transaction ${cleanTxnId} created successfully.`,
        data: created
      });
    } catch (err: any) {
      console.error('Create transaction error:', err);
      res.status(500).json({
        success: false,
        error: `Failed to create transaction: ${err.message}`
      });
    }
  }

  public static async deleteTransaction(req: Request, res: Response): Promise<void> {
    try {
      const db = getDatabase();
      const { id } = req.params;

      const existing = db.prepare('SELECT transaction_id FROM transactions WHERE transaction_id = ?').get(id);
      if (!existing) {
        res.status(404).json({ success: false, error: `Transaction ${id} not found.` });
        return;
      }

      // Detach any matched settlement records so they become UNMATCHED
      db.prepare('UPDATE settlement_history SET transaction_id = NULL WHERE transaction_id = ?').run(id);
      db.prepare('DELETE FROM transactions WHERE transaction_id = ?').run(id);

      res.status(200).json({
        success: true,
        message: `Transaction ${id} deleted successfully.`
      });
    } catch (err: any) {
      console.error('Delete transaction error:', err);
      res.status(500).json({
        success: false,
        error: `Failed to delete transaction: ${err.message}`
      });
    }
  }

  public static async bulkCreateTransactions(req: Request, res: Response): Promise<void> {
    try {
      const db = getDatabase();
      const { transactions } = req.body;

      if (!Array.isArray(transactions) || transactions.length === 0) {
        res.status(400).json({ success: false, error: 'A non-empty transactions array is required.' });
        return;
      }

      const todayStr = new Date().toISOString().split('T')[0];
      const settlementService = new SettlementService(db);
      let insertedCount = 0;
      let skippedCount = 0;
      const insertedIds: string[] = [];
      const errors: string[] = [];

      const insertTxnStmt = db.prepare(`
        INSERT INTO transactions (
          transaction_id, lifecycle_id, account_id, merchant_name,
          transaction_date, transaction_amount, currency, status,
          settlement_status, total_settled_amount, last_settlement_date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0.00, NULL)
      `);

      const checkExistingStmt = db.prepare('SELECT transaction_id FROM transactions WHERE transaction_id = ?');

      const runBatch = db.transaction(() => {
        for (let i = 0; i < transactions.length; i++) {
          const t = transactions[i];
          const rawId = t.transaction_id || t.id || t['Transaction ID'] || t['Txn ID'];
          if (!rawId || !String(rawId).trim()) {
            errors.push(`Row ${i + 1}: Missing transaction_id`);
            continue;
          }

          const cleanTxnId = String(rawId).trim().toUpperCase();
          const existing = checkExistingStmt.get(cleanTxnId);
          if (existing) {
            skippedCount++;
            continue;
          }

          const rawAmount = t.transaction_amount !== undefined ? t.transaction_amount : (t.amount !== undefined ? t.amount : t['Amount']);
          const numAmount = Number(String(rawAmount).replace(/[^0-9.-]+/g, ''));
          if (isNaN(numAmount) || numAmount <= 0) {
            errors.push(`Row ${i + 1} (${cleanTxnId}): Invalid positive amount "${rawAmount}"`);
            continue;
          }

          const rawAccount = t.account_id || t.account || t['Account ID'] || 'ACC100';
          const cleanAccount = String(rawAccount).trim().toUpperCase();

          const rawMerchant = t.merchant_name || t.merchant || t['Merchant Name'] || 'Unknown Merchant';
          const cleanMerchant = String(rawMerchant).trim();

          const rawDate = t.transaction_date || t.date || t['Transaction Date'] || t['Date'] || todayStr;
          const txnDate = String(rawDate).trim();

          const rawLifecycle = t.lifecycle_id || t.lifecycle || t['Lifecycle ID'] || null;
          const cleanLifecycle = rawLifecycle && String(rawLifecycle).trim() ? String(rawLifecycle).trim().toUpperCase() : null;

          const rawStatus = t.status || t['Status'] || 'COMPLETED';
          const cleanStatus = String(rawStatus).trim().toUpperCase();

          const rawCurrency = t.currency || t['Currency'] || 'USD';
          const cleanCurrency = String(rawCurrency).trim().toUpperCase();

          const initialSettlementStatus = (cleanStatus === 'FAILED' || cleanStatus === 'DECLINED') ? 'NOT_APPLICABLE' : 'PENDING';

          insertTxnStmt.run(
            cleanTxnId,
            cleanLifecycle,
            cleanAccount,
            cleanMerchant,
            txnDate,
            numAmount,
            cleanCurrency,
            cleanStatus,
            initialSettlementStatus
          );

          insertedIds.push(cleanTxnId);
          insertedCount++;
        }
      });

      runBatch();

      // Recalculate settlement statuses for newly inserted transactions against existing settlement_history
      for (const id of insertedIds) {
        try {
          settlementService.recalculateTransaction(id);
        } catch (e) {}
      }

      res.status(200).json({
        success: true,
        message: `Bulk import completed: ${insertedCount} inserted, ${skippedCount} duplicate IDs skipped.`,
        insertedCount,
        skippedCount,
        errors
      });
    } catch (err: any) {
      console.error('Bulk create transactions error:', err);
      res.status(500).json({
        success: false,
        error: `Failed to bulk import transactions: ${err.message}`
      });
    }
  }
}
