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
  run_id?: string | null;
  match_method?: 'PRIMARY_LIFECYCLE' | 'FALLBACK_COMPOSITE' | null;
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
  ambiguousRecords?: number;
  transactionsUpdated: number;
}

export interface ReconciliationResult {
  success: boolean;
  runId?: string;
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

export type RunStatus = 'COMPLETED' | 'PARTIAL' | 'FAILED';

export interface ReconciliationRun {
  run_id: string;
  file_name: string;
  file_size_bytes: number;
  status: RunStatus;
  records_read: number;
  matched_records: number;
  new_settlements_inserted: number;
  duplicates_skipped: number;
  invalid_records: number;
  unmatched_records: number;
  ambiguous_records: number;
  transactions_updated: number;
  duration_ms: number;
  error_message?: string | null;
  created_at: string;
}

export type RunItemType = 'INVALID' | 'UNMATCHED' | 'AMBIGUOUS' | 'CONFLICT' | 'SKIPPED_DUPLICATE' | 'MATCHED';

export interface ReconciliationRunItem {
  id: number;
  run_id: string;
  row_number?: number | null;
  settlement_id?: string | null;
  item_type: RunItemType;
  reason?: string | null;
  raw_data?: string | null;
  created_at?: string;
}

export type ExceptionReviewStatus = 'UNREVIEWED' | 'UNDER_REVIEW' | 'RESOLVED';

export interface ExceptionReview {
  exception_id: string;
  transaction_id: string | null;
  issue_code: string;
  severity: IssueSeverity;
  review_status: ExceptionReviewStatus;
  notes?: string | null;
  reviewed_by: string;
  updated_at: string;
  created_at: string;
}

export interface ExceptionItem {
  exception_id: string;
  transaction_id: string | null;
  merchant_name: string;
  issue_type: string;
  severity: IssueSeverity;
  expected_amount: number;
  net_settled_amount: number;
  difference_amount: number;
  detection_date: string;
  review_status: ExceptionReviewStatus;
  notes?: string | null;
  recommendation: string;
  description: string;
  matching_method?: string | null;
  settlement_count?: number;
}

export interface CSVPreviewRow {
  row_number: number;
  settlement_id: string;
  lifecycle_id: string | null;
  account_id: string;
  merchant_name: string;
  transaction_date: string;
  settlement_date: string;
  settlement_amount: number | null;
  settlement_type: string;
  currency: string;
  status: 'VALID_MATCH' | 'POTENTIAL_UNMATCHED' | 'AMBIGUOUS' | 'CURRENCY_MISMATCH' | 'DUPLICATE' | 'CONFLICT' | 'INVALID';
  status_message?: string;
  matched_transaction_id?: string | null;
}

export interface CSVPreviewResult {
  success: boolean;
  fileName: string;
  fileSizeBytes: number;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  columnsFound: string[];
  missingColumns: string[];
  previewRows: CSVPreviewRow[];
  errors: Array<{ rowNumber?: number; error: string }>;
}

export interface AgingBandMetrics {
  count: number;
  totalOutstanding: number;
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
  agingBands: {
    zeroToThreeDays: AgingBandMetrics;
    fourToSevenDays: AgingBandMetrics;
    overSevenDays: AgingBandMetrics;
  };
  totalOutstandingAmount: number;
  totalSettledAmount: number;
  totalExcessAmount: number;
  averageDaysToSettle: number;
  settlementRate: number; // percentage (0-100)
  latestDate: string;
  totalRuns: number;
  unmatchedSettlementCount: number;
  activeRunId?: string | null;
  runDetails?: ReconciliationRun | null;
}
