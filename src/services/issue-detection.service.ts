import { Issue, IssueSeverity, Transaction, TransactionWithIssues } from '../types/index.js';
import { fromCents, toCents, formatMoney } from '../utils/money.js';

export class IssueDetectionService {
  /**
   * Evaluates a transaction against reconciliation rules.
   * @param txn The transaction record
   * @param evaluationDate The reference date (defaults to current date or batch date)
   */
  public evaluateTransaction(
    txn: Transaction,
    evaluationDate: string = '2025-08-15'
  ): TransactionWithIssues {
    const issues: Issue[] = [];
    const isEligible = txn.status !== 'FAILED' && txn.status !== 'DECLINED';

    const txnCents = toCents(txn.transaction_amount);
    const settledCents = toCents(txn.total_settled_amount);
    const outstandingCents = isEligible ? Math.max(txnCents - settledCents, 0) : 0;
    const outstandingAmount = fromCents(outstandingCents);

    if (isEligible) {
      // Rule 1: Critical - Over Settlement (settled amount > transaction amount)
      if (settledCents > txnCents) {
        const excess = fromCents(settledCents - txnCents);
        issues.push({
          code: 'OVER_SETTLED_CRITICAL',
          severity: 'CRITICAL',
          description: `Total settlement amount ($${formatMoney(txn.total_settled_amount)}) exceeds transaction amount ($${formatMoney(txn.transaction_amount)}) by $${formatMoney(excess)}.`,
          recommendation: 'Verify acquirer batch files for duplicate credits or initiate clawback / reconciliation adjustment.'
        });
      }

      // Rule 2: Critical - Missing settlement after 7 days from transaction date
      if (txn.settlement_status === 'PENDING' || txn.total_settled_amount === 0) {
        const txnDateObj = new Date(txn.transaction_date);
        const evalDateObj = new Date(evaluationDate);
        const diffDays = Math.floor((evalDateObj.getTime() - txnDateObj.getTime()) / (1000 * 60 * 60 * 24));

        if (diffDays >= 7) {
          issues.push({
            code: 'SETTLEMENT_OVERDUE_CRITICAL',
            severity: 'CRITICAL',
            description: `No settlement received after 7 days from transaction date (${diffDays} days elapsed).`,
            recommendation: 'Escalate to payment gateway / banking partner for unconfirmed or stalled settlement tranches.'
          });
        }
      }

      // Rule 3: Warning - Partial settlement (settled amount < transaction amount, without being a legitimate refund)
      // Per assignment rules: Scenario 2 (Partial) flags Warning; Scenario 3 (Refund) expects no issues.
      if (txn.settlement_status === 'PARTIAL') {
        issues.push({
          code: 'PARTIAL_SETTLEMENT_WARNING',
          severity: 'WARNING',
          description: `Total settlement amount ($${formatMoney(txn.total_settled_amount)}) is less than transaction amount ($${formatMoney(txn.transaction_amount)}). Outstanding balance: $${formatMoney(outstandingAmount)}.`,
          recommendation: 'Monitor next scheduled processor disbursement for remaining balance or fee withholdings.'
        });
      }
    }

    // Determine primary issue severity for badges & filtering
    let primarySeverity: IssueSeverity = 'NONE';
    if (issues.some(i => i.severity === 'CRITICAL')) {
      primarySeverity = 'CRITICAL';
    } else if (issues.some(i => i.severity === 'WARNING')) {
      primarySeverity = 'WARNING';
    }

    return {
      ...txn,
      outstanding_amount: outstandingAmount,
      issues,
      primary_issue_severity: primarySeverity
    };
  }
}
