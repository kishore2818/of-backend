import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MatchingService } from '../src/services/matching.service.js';
import { SettlementService } from '../src/services/settlement.service.js';
import { IssueDetectionService } from '../src/services/issue-detection.service.js';
import { ReconciliationService } from '../src/services/reconciliation.service.js';
import { resetAndSeedDatabase } from '../src/db/seed.js';

describe('Reconciliation Engine Unit Tests', () => {
  let db: Database.Database;
  let matchingService: MatchingService;
  let settlementService: SettlementService;
  let issueService: IssueDetectionService;
  let reconciliationService: ReconciliationService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    resetAndSeedDatabase(db);

    matchingService = new MatchingService(db);
    settlementService = new SettlementService(db);
    issueService = new IssueDetectionService();
    reconciliationService = new ReconciliationService(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('Core Matching Logic', () => {
    it('Scenario 1: Matches transaction accurately via primary lifecycle_id', () => {
      const match = matchingService.match({
        settlement_id: 'SET001',
        lifecycle_id: 'LC001',
        account_id: 'ACC123',
        merchant_name: 'Amazon.com',
        transaction_date: '2025-08-14',
        settlement_date: '2025-08-15',
        settlement_amount: 125.99,
        settlement_type: 'DEBIT',
        currency: 'USD'
      });

      expect(match.status).toBe('MATCHED');
      expect(match.matchType).toBe('PRIMARY_LIFECYCLE');
      expect(match.transaction?.transaction_id).toBe('TXN001');
    });

    it('Scenario 5: Fallback matches when lifecycle_id is missing', () => {
      const match = matchingService.match({
        settlement_id: 'SET014',
        lifecycle_id: null,
        account_id: 'ACC135',
        merchant_name: 'Corner Deli',
        transaction_date: '2025-08-14',
        settlement_date: '2025-08-15',
        settlement_amount: 32.45,
        settlement_type: 'DEBIT',
        currency: 'USD'
      });

      expect(match.status).toBe('MATCHED');
      expect(match.matchType).toBe('FALLBACK_COMPOSITE');
      expect(match.transaction?.transaction_id).toBe('TXN013');
    });

    it('Detects currency mismatch and prevents association', () => {
      const match = matchingService.match({
        settlement_id: 'SET_EUR',
        lifecycle_id: 'LC001',
        account_id: 'ACC123',
        merchant_name: 'Amazon.com',
        transaction_date: '2025-08-14',
        settlement_date: '2025-08-15',
        settlement_amount: 125.99,
        settlement_type: 'DEBIT',
        currency: 'EUR'
      });

      expect(match.status).toBe('CURRENCY_MISMATCH');
      expect(match.reason).toContain('Currency mismatch');
    });

    it('Returns UNMATCHED when neither primary nor fallback matches', () => {
      const match = matchingService.match({
        settlement_id: 'SET016',
        lifecycle_id: 'LC999',
        account_id: 'ACC199',
        merchant_name: 'Disney Plus',
        transaction_date: '2025-08-14',
        settlement_date: '2025-08-15',
        settlement_amount: 99.99,
        settlement_type: 'DEBIT',
        currency: 'USD'
      });

      expect(match.status).toBe('UNMATCHED');
    });
  });

  describe('Settlement Status & Transitions', () => {
    it('Scenario 1: Perfect Match sets status FULLY_SETTLED', () => {
      const status = settlementService.determineSettlementStatus(100.0, 100.0, true, false, 'COMPLETED');
      expect(status).toBe('FULLY_SETTLED');
    });

    it('Scenario 2: Partial Settlement sets status PARTIAL', () => {
      const status = settlementService.determineSettlementStatus(100.0, 80.0, true, false, 'COMPLETED');
      expect(status).toBe('PARTIAL');
    });

    it('Scenario 4: Over Settlement sets status OVER_SETTLED', () => {
      const status = settlementService.determineSettlementStatus(100.0, 120.0, true, false, 'COMPLETED');
      expect(status).toBe('OVER_SETTLED');
    });

    it('Scenario 6: Status Transitions (PENDING -> PARTIAL -> FULLY_SETTLED)', () => {
      // 1. Initially PENDING
      const initial = settlementService.determineSettlementStatus(100.0, 0, false, false, 'COMPLETED');
      expect(initial).toBe('PENDING');

      // 2. First tranche $50.00 -> PARTIAL
      const partial = settlementService.determineSettlementStatus(100.0, 50.0, true, false, 'COMPLETED');
      expect(partial).toBe('PARTIAL');

      // 3. Second tranche $50.00 -> FULLY_SETTLED
      const full = settlementService.determineSettlementStatus(100.0, 100.0, true, false, 'COMPLETED');
      expect(full).toBe('FULLY_SETTLED');
    });

    it('Scenario 7: Complex Refund Case sets status REFUNDED', () => {
      // Transaction $100.00, DEBIT $100.00 + CREDIT $30.00 -> Net $70.00
      const status = settlementService.determineSettlementStatus(100.0, 70.0, true, true, 'COMPLETED');
      expect(status).toBe('REFUNDED');
    });
  });

  describe('Issue Detection Rules', () => {
    it('Flags OVER_SETTLED as CRITICAL issue', () => {
      const evaluated = issueService.evaluateTransaction({
        transaction_id: 'TXN007',
        lifecycle_id: 'LC007',
        account_id: 'ACC129',
        merchant_name: 'Walmart',
        transaction_date: '2025-08-14',
        transaction_amount: 156.78,
        currency: 'USD',
        status: 'COMPLETED',
        settlement_status: 'OVER_SETTLED',
        total_settled_amount: 180.78,
        last_settlement_date: '2025-08-15'
      });

      expect(evaluated.primary_issue_severity).toBe('CRITICAL');
      expect(evaluated.issues.some(i => i.code === 'OVER_SETTLED_CRITICAL')).toBe(true);
    });

    it('Flags missing settlement after 7 days as CRITICAL issue', () => {
      const evaluated = issueService.evaluateTransaction({
        transaction_id: 'TXN010',
        lifecycle_id: 'LC010',
        account_id: 'ACC132',
        merchant_name: 'Netflix',
        transaction_date: '2025-08-07',
        transaction_amount: 15.99,
        currency: 'USD',
        status: 'COMPLETED',
        settlement_status: 'PENDING',
        total_settled_amount: 0.0,
        last_settlement_date: null
      }, '2025-08-15');

      expect(evaluated.primary_issue_severity).toBe('CRITICAL');
      expect(evaluated.issues.some(i => i.code === 'SETTLEMENT_OVERDUE_CRITICAL')).toBe(true);
    });

    it('Flags PARTIAL settlement as WARNING issue with correct outstanding amount', () => {
      const evaluated = issueService.evaluateTransaction({
        transaction_id: 'TXN003',
        lifecycle_id: 'LC003',
        account_id: 'ACC125',
        merchant_name: 'Shell Gas',
        transaction_date: '2025-08-14',
        transaction_amount: 45.30,
        currency: 'USD',
        status: 'COMPLETED',
        settlement_status: 'PARTIAL',
        total_settled_amount: 35.30,
        last_settlement_date: '2025-08-15'
      });

      expect(evaluated.primary_issue_severity).toBe('WARNING');
      expect(evaluated.outstanding_amount).toBe(10.00);
      expect(evaluated.issues.some(i => i.code === 'PARTIAL_SETTLEMENT_WARNING')).toBe(true);
    });

    it('Scenario 3: Refund with legitimate credit has no issues', () => {
      const evaluated = issueService.evaluateTransaction({
        transaction_id: 'TXN004',
        lifecycle_id: 'LC004',
        account_id: 'ACC126',
        merchant_name: 'Best Buy',
        transaction_date: '2025-08-14',
        transaction_amount: 899.99,
        currency: 'USD',
        status: 'COMPLETED',
        settlement_status: 'REFUNDED',
        total_settled_amount: 879.99,
        last_settlement_date: '2025-08-15'
      });

      expect(evaluated.primary_issue_severity).toBe('NONE');
      expect(evaluated.issues.length).toBe(0);
    });
  });

  describe('Full CSV Reconciliation Pipeline', () => {
    it('Reconciles CSV batch, calculates totals, and skips duplicates on second import', () => {
      const csvData = `settlement_id,lifecycle_id,account_id,merchant_name,transaction_date,settlement_date,settlement_amount,settlement_type,currency
SET001,LC001,ACC123,Amazon.com,2025-08-14,2025-08-15,125.99,DEBIT,USD
SET002,LC002,ACC124,Starbucks,2025-08-14,2025-08-15,4.75,DEBIT,USD`;

      const firstRun = reconciliationService.reconcileCSV(csvData);
      expect(firstRun.success).toBe(true);
      expect(firstRun.summary.recordsRead).toBe(2);
      expect(firstRun.summary.newSettlementsInserted).toBe(2);
      expect(firstRun.summary.transactionsUpdated).toBe(2);

      // Reconcile same CSV again to test idempotency & duplicate prevention
      const secondRun = reconciliationService.reconcileCSV(csvData);
      expect(secondRun.success).toBe(true);
      expect(secondRun.summary.newSettlementsInserted).toBe(0);
      expect(secondRun.summary.duplicatesSkipped).toBe(2);
    });
  });
});
