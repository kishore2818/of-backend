import Database from 'better-sqlite3';
import { ParsedSettlementRecord, Transaction } from '../types/index.js';

export type MatchResultStatus = 'MATCHED' | 'UNMATCHED' | 'AMBIGUOUS' | 'CURRENCY_MISMATCH';

export interface MatchResult {
  status: MatchResultStatus;
  transaction: Transaction | null;
  matchType?: 'PRIMARY_LIFECYCLE' | 'FALLBACK_COMPOSITE';
  reason?: string;
}

export class MatchingService {
  private stmtFindPrimary: Database.Statement;
  private stmtFindFallback: Database.Statement;

  constructor(private db: Database.Database) {
    this.stmtFindPrimary = this.db.prepare<[string]>(
      'SELECT * FROM transactions WHERE lifecycle_id = ?'
    );
    this.stmtFindFallback = this.db.prepare<[string, string, string]>(
      'SELECT * FROM transactions WHERE account_id = ? AND merchant_name = ? AND transaction_date = ?'
    );
  }

  public match(record: ParsedSettlementRecord): MatchResult {
    // 1. Primary Matching via lifecycle_id
    if (record.lifecycle_id && record.lifecycle_id.trim().length > 0) {
      const candidates = this.stmtFindPrimary.all(record.lifecycle_id.trim()) as Transaction[];

      if (candidates.length === 1) {
        const candidate = candidates[0];
        if (candidate.currency !== record.currency) {
          return {
            status: 'CURRENCY_MISMATCH',
            transaction: candidate,
            reason: `Currency mismatch: transaction currency is ${candidate.currency}, settlement currency is ${record.currency}`
          };
        }
        return {
          status: 'MATCHED',
          transaction: candidate,
          matchType: 'PRIMARY_LIFECYCLE'
        };
      }

      if (candidates.length > 1) {
        return {
          status: 'AMBIGUOUS',
          transaction: null,
          reason: `Multiple transactions (${candidates.length}) match lifecycle_id "${record.lifecycle_id}"`
        };
      }

      // Lifecycle ID is present but not found in transactions
      return {
        status: 'UNMATCHED',
        transaction: null,
        reason: `No transaction found with lifecycle_id "${record.lifecycle_id}"`
      };
    }

    // 2. Fallback Matching via account_id + merchant_name + transaction_date
    const fallbackCandidates = this.stmtFindFallback.all(
      record.account_id.trim(),
      record.merchant_name.trim(),
      record.transaction_date.trim()
    ) as Transaction[];

    if (fallbackCandidates.length === 1) {
      const candidate = fallbackCandidates[0];
      if (candidate.currency !== record.currency) {
        return {
          status: 'CURRENCY_MISMATCH',
          transaction: candidate,
          reason: `Currency mismatch: transaction currency is ${candidate.currency}, settlement currency is ${record.currency}`
        };
      }
      return {
        status: 'MATCHED',
        transaction: candidate,
        matchType: 'FALLBACK_COMPOSITE'
      };
    }

    if (fallbackCandidates.length > 1) {
      return {
        status: 'AMBIGUOUS',
        transaction: null,
        reason: `Multiple transactions (${fallbackCandidates.length}) match fallback criteria (account_id="${record.account_id}", merchant="${record.merchant_name}", date="${record.transaction_date}")`
      };
    }

    return {
      status: 'UNMATCHED',
      transaction: null,
      reason: `No transaction found matching fallback criteria (account_id="${record.account_id}", merchant="${record.merchant_name}", date="${record.transaction_date}")`
    };
  }
}
