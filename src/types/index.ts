export type TransactionStatus = 'COMPLETED' | 'FAILED' | 'DECLINED';

export type SettlementStatus =
  | 'PENDING'
  | 'PARTIAL'
  | 'FULLY_SETTLED'
  | 'OVER_SETTLED'
  | 'REFUNDED'
  | 'NOT_APPLICABLE';

export type SettlementType = 'DEBIT' | 'CREDIT';

export type IssueSeverity = 'CRITICAL' | 'WARNING' | 'NONE';

export interface Issue {
  code: string;
  severity: IssueSeverity;
  description: string;
  recommendation: string;
}

export interface Transaction {
  transaction_id: string;
  lifecycle_id: string | null;
  account_id: string;
  merchant_name: string;
  transaction_date: string;
  transaction_amount: number;
  currency: string;
  status: TransactionStatus;
  settlement_status: SettlementStatus;
  total_settled_amount: number;
  last_settlement_date: string | null;
  created_at?: string;
}

export interface SettlementHistory {
  settlement_id: string;
  transaction_id: string | null;
  lifecycle_id: string | null;
  settlement_date: string;
  settlement_amount: number;
  settlement_type: SettlementType;
  currency: string;
  processed_at?: string;
}

export interface TransactionWithIssues extends Transaction {
  outstanding_amount: number;
  issues: Issue[];
  primary_issue_severity: IssueSeverity;
}

export interface CSVRawRecord {
  settlement_id: string;
  lifecycle_id?: string;
  account_id: string;
  merchant_name: string;
  transaction_date: string;
  settlement_date: string;
  settlement_amount: string;
  settlement_type: string;
  currency: string;
}

export interface ParsedSettlementRecord {
  settlement_id: string;
  lifecycle_id: string | null;
  account_id: string;
  merchant_name: string;
  transaction_date: string;
  settlement_date: string;
  settlement_amount: number;
  settlement_type: SettlementType;
  currency: string;
}

export interface ReconciliationSummary {
  recordsRead: number;
  matchedRecords: number;
  newSettlementsInserted: number;
  duplicatesSkipped: number;
  invalidRecords: number;
  unmatchedRecords: number;
  transactionsUpdated: number;
}

export interface ReconciliationResult {
  success: boolean;
  summary: ReconciliationSummary;
  errors: Array<{
    recordId?: string;
    rowNumber?: number;
    error: string;
    details?: any;
  }>;
  unmatched: Array<{
    settlement_id: string;
    reason: string;
    record: Partial<ParsedSettlementRecord>;
  }>;
}

export interface DashboardSummary {
  totalTransactions: number;
  eligibleTransactions: number;
  totalSettlementRecords: number;
  statusBreakdown: {
    pending: number;
    partial: number;
    fullySettled: number;
    overSettled: number;
    refunded: number;
    notApplicable: number;
  };
  issueBreakdown: {
    criticalCount: number;
    warningCount: number;
    cleanCount: number;
  };
  totalOutstandingAmount: number;
  totalSettledAmount: number;
  averageDaysToSettle: number;
  settlementRate: number; // percentage (0-100)
}
