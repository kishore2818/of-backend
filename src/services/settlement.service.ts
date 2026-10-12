import Database from 'better-sqlite3';
import { SettlementHistory, SettlementStatus, Transaction } from '../types/index.js';
import { fromCents, toCents } from '../utils/money.js';

export class SettlementService {
  private stmtGetHistory: Database.Statement;
  private stmtUpdateTxn: Database.Statement;

  constructor(private db: Database.Database) {
    this.stmtGetHistory = this.db.prepare<[string]>(
      'SELECT * FROM settlement_history WHERE transaction_id = ? ORDER BY settlement_date ASC, processed_at ASC'
    );
    this.stmtUpdateTxn = this.db.prepare<[number, string, string | null, string]>(
      'UPDATE transactions SET total_settled_amount = ?, settlement_status = ?, last_settlement_date = ? WHERE transaction_id = ?'
    );
  }

  /**
   * Determine settlement status based on financial rules:
   * 1. No settlements -> PENDING
   * 2. If refund occurred and net settled amount < transaction amount -> REFUNDED
   * 3. Net settled amount > transaction amount -> OVER_SETTLED
   * 4. Net settled amount == transaction amount -> FULLY_SETTLED
   * 5. Otherwise (0 < net < transaction amount, without refund) -> PARTIAL
   */
  public determineSettlementStatus(
    txnAmount: number,
    netSettled: number,
    hasSettlements: boolean,
    hasRefund: boolean,
    originalTxnStatus: string
  ): SettlementStatus {
    if (originalTxnStatus === 'FAILED' || originalTxnStatus === 'DECLINED') {
      return 'NOT_APPLICABLE';
    }

    if (!hasSettlements) {
      return 'PENDING';
    }

    const txnCents = toCents(txnAmount);
    const netCents = toCents(netSettled);

    if (hasRefund && netCents < txnCents) {
      return 'REFUNDED';
    }

    if (netCents > txnCents) {
      return 'OVER_SETTLED';
    }

    if (netCents === txnCents) {
      return 'FULLY_SETTLED';
    }

    return 'PARTIAL';
  }

  /**
   * Recalculates and updates the cumulative settlement summary for a transaction
   * by aggregating all valid records in settlement_history.
   */
  public recalculateTransaction(transactionId: string): {
    totalSettledAmount: number;
    settlementStatus: SettlementStatus;
    lastSettlementDate: string | null;
  } {
    const txn = this.db.prepare<[string]>('SELECT * FROM transactions WHERE transaction_id = ?').get(transactionId) as Transaction | undefined;
    if (!txn) {
      throw new Error(`Transaction not found: ${transactionId}`);
    }

    const history = this.stmtGetHistory.all(transactionId) as SettlementHistory[];

    if (txn.status === 'FAILED' || txn.status === 'DECLINED') {
      return {
        totalSettledAmount: 0,
        settlementStatus: 'NOT_APPLICABLE',
        lastSettlementDate: null
      };
    }

    let netCents = 0;
    let hasRefund = false;
    let latestDate: string | null = null;

    for (const record of history) {
      const recordCents = toCents(record.settlement_amount);
      if (record.settlement_type === 'DEBIT') {
        netCents += recordCents;
      } else if (record.settlement_type === 'CREDIT') {
        netCents -= recordCents;
        hasRefund = true;
      }

      if (!latestDate || record.settlement_date > latestDate) {
        latestDate = record.settlement_date;
      }
    }

    const totalSettledAmount = fromCents(netCents);
    const settlementStatus = this.determineSettlementStatus(
      txn.transaction_amount,
      totalSettledAmount,
      history.length > 0,
      hasRefund,
      txn.status
    );

    this.stmtUpdateTxn.run(totalSettledAmount, settlementStatus, latestDate, transactionId);

    return {
      totalSettledAmount,
      settlementStatus,
      lastSettlementDate: latestDate
    };
  }
}
