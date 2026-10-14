import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { createApp } from '../src/app.js';
import { setDatabaseInstance } from '../src/db/index.js';
import { resetAndSeedDatabase } from '../src/db/seed.js';

describe('API Integration Tests', () => {
  let app: any;
  let testDb: Database.Database;

  beforeAll(() => {
    testDb = new Database(':memory:');
    testDb.pragma('foreign_keys = ON');
    resetAndSeedDatabase(testDb);
    setDatabaseInstance(testDb);

    app = createApp();
  });

  afterAll(() => {
    testDb.close();
  });

  it('GET /health returns healthy status', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /dashboard/summary returns initial un-reconciled metrics with aging bands', async () => {
    const res = await request(app).get('/dashboard/summary');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.totalTransactions).toBe(14);
    expect(res.body.data.eligibleTransactions).toBe(12);
    expect(res.body.data.statusBreakdown.pending).toBe(12);
    expect(res.body.data.agingBands).toBeDefined();
  });

  it('POST /reconcile/preview previews CSV without inserting', async () => {
    const sampleCsv = `settlement_id,lifecycle_id,account_id,merchant_name,transaction_date,settlement_date,settlement_amount,settlement_type,currency
SET001,LC001,ACC123,Amazon.com,2025-08-14,2025-08-15,125.99,DEBIT,USD`;

    const res = await request(app)
      .post('/reconcile/preview')
      .send({ csv: sampleCsv });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.totalRows).toBe(1);
    expect(res.body.validRows).toBe(1);
    expect(res.body.previewRows[0].status).toBe('VALID_MATCH');
  });

  it('GET /transactions returns initial list of transactions', async () => {
    const res = await request(app).get('/transactions');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.length).toBe(14);
  });

  it('POST /reconcile successfully processes CSV payload and records run', async () => {
    const sampleCsv = `settlement_id,lifecycle_id,account_id,merchant_name,transaction_date,settlement_date,settlement_amount,settlement_type,currency
SET001,LC001,ACC123,Amazon.com,2025-08-14,2025-08-15,125.99,DEBIT,USD
SET002,LC002,ACC124,Starbucks,2025-08-14,2025-08-15,4.75,DEBIT,USD
SET014,,ACC135,Corner Deli,2025-08-14,2025-08-15,32.45,DEBIT,USD
SET016,LC999,ACC199,Disney Plus,2025-08-14,2025-08-15,99.99,DEBIT,USD`;

    const res = await request(app)
      .post('/reconcile')
      .send({ csv: sampleCsv, fileName: 'api_test.csv' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.summary.recordsRead).toBe(4);
    expect(res.body.summary.matchedRecords).toBe(3);
    expect(res.body.summary.unmatchedRecords).toBe(1);
    expect(res.body.summary.newSettlementsInserted).toBe(3);
    expect(res.body.runId).toBeDefined();
  });

  it('GET /reconciliation-runs returns list of runs', async () => {
    const res = await request(app).get('/reconciliation-runs');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(res.body.runs[0].file_name).toBe('api_test.csv');
  });

  it('GET /reconciliation-runs/:id and export-rejected work correctly', async () => {
    const runsRes = await request(app).get('/reconciliation-runs');
    const runId = runsRes.body.runs[0].run_id;

    const detailRes = await request(app).get(`/reconciliation-runs/${runId}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.data.run.run_id).toBe(runId);
    expect(detailRes.body.data.items.length).toBeGreaterThanOrEqual(1);

    const exportRes = await request(app).get(`/reconciliation-runs/${runId}/export-rejected`);
    expect(exportRes.status).toBe(200);
    expect(exportRes.header['content-type']).toContain('text/csv');
  });

  it('GET /transactions/:id returns transaction details with financialExplanation and timeline', async () => {
    const res = await request(app).get('/transactions/TXN001');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.transaction_id).toBe('TXN001');
    expect(res.body.data.settlement_status).toBe('FULLY_SETTLED');
    expect(res.body.data.financialExplanation).toBeDefined();
    expect(res.body.data.financialExplanation.formula).toContain('Total Debits - Total Credits');
    expect(res.body.data.settlements.length).toBe(1);
    expect(res.body.data.timeline.length).toBeGreaterThanOrEqual(2);
  });

  it('GET /transactions/:id/export-settlements downloads CSV of transaction settlements', async () => {
    const res = await request(app).get('/transactions/TXN001/export-settlements');
    expect(res.status).toBe(200);
    expect(res.header['content-type']).toContain('text/csv');
    expect(res.text).toContain('SET001');
  });

  it('GET /transactions/export downloads filtered transactions CSV', async () => {
    const res = await request(app).get('/transactions/export?status=FULLY_SETTLED');
    expect(res.status).toBe(200);
    expect(res.header['content-type']).toContain('text/csv');
    expect(res.text).toContain('TXN001');
  });

  it('GET /exceptions lists exceptions and PATCH /exceptions/:id/review updates review state', async () => {
    const res = await request(app).get('/exceptions');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.exceptions.length).toBeGreaterThanOrEqual(1);

    const first = res.body.exceptions[0];
    const patchRes = await request(app)
      .patch(`/exceptions/${first.exception_id}/review`)
      .send({ reviewStatus: 'UNDER_REVIEW', notes: 'API test review note' });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.data.review_status).toBe('UNDER_REVIEW');
  });

  it('GET /exceptions/export downloads exceptions CSV', async () => {
    const res = await request(app).get('/exceptions/export');
    expect(res.status).toBe(200);
    expect(res.header['content-type']).toContain('text/csv');
    expect(res.text).toContain('exception_id');
  });

  it('GET /dashboard/summary reflects newly reconciled settlements', async () => {
    const res = await request(app).get('/dashboard/summary');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.totalSettlementRecords).toBe(3);
    expect(res.body.data.statusBreakdown.fullySettled).toBe(3);
  });
});
