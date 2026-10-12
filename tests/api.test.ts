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

  it('GET /dashboard/summary returns initial un-reconciled metrics', async () => {
    const res = await request(app).get('/dashboard/summary');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.totalTransactions).toBe(14);
    expect(res.body.data.eligibleTransactions).toBe(12);
    expect(res.body.data.statusBreakdown.pending).toBe(12);
  });

  it('GET /transactions returns initial list of transactions', async () => {
    const res = await request(app).get('/transactions');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.length).toBe(14);
  });

  it('POST /reconcile successfully processes CSV payload', async () => {
    const sampleCsv = `settlement_id,lifecycle_id,account_id,merchant_name,transaction_date,settlement_date,settlement_amount,settlement_type,currency
SET001,LC001,ACC123,Amazon.com,2025-08-14,2025-08-15,125.99,DEBIT,USD
SET002,LC002,ACC124,Starbucks,2025-08-14,2025-08-15,4.75,DEBIT,USD
SET014,,ACC135,Corner Deli,2025-08-14,2025-08-15,32.45,DEBIT,USD
SET016,LC999,ACC199,Disney Plus,2025-08-14,2025-08-15,99.99,DEBIT,USD`;

    const res = await request(app)
      .post('/reconcile')
      .send({ csv: sampleCsv });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.summary.recordsRead).toBe(4);
    expect(res.body.summary.matchedRecords).toBe(3);
    expect(res.body.summary.unmatchedRecords).toBe(1);
    expect(res.body.summary.newSettlementsInserted).toBe(3);
  });

  it('GET /transactions/:id returns transaction details with settlement history and timeline', async () => {
    const res = await request(app).get('/transactions/TXN001');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.transaction_id).toBe('TXN001');
    expect(res.body.data.settlement_status).toBe('FULLY_SETTLED');
    expect(res.body.data.settlements.length).toBe(1);
    expect(res.body.data.timeline.length).toBeGreaterThanOrEqual(2);
  });

  it('GET /dashboard/summary reflects newly reconciled settlements', async () => {
    const res = await request(app).get('/dashboard/summary');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.totalSettlementRecords).toBe(3);
    expect(res.body.data.statusBreakdown.fullySettled).toBe(3);
  });
});
