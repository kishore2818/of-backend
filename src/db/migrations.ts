import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';

export function runMigrations(db: Database.Database): void {
  // 1. Ensure core reconciliation_runs table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS reconciliation_runs (
      run_id VARCHAR(50) PRIMARY KEY,
      file_name VARCHAR(255) NOT NULL,
      file_size_bytes INTEGER DEFAULT 0,
      status VARCHAR(20) NOT NULL,
      records_read INTEGER DEFAULT 0,
      matched_records INTEGER DEFAULT 0,
      new_settlements_inserted INTEGER DEFAULT 0,
      duplicates_skipped INTEGER DEFAULT 0,
      invalid_records INTEGER DEFAULT 0,
      unmatched_records INTEGER DEFAULT 0,
      ambiguous_records INTEGER DEFAULT 0,
      transactions_updated INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      error_message TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS reconciliation_run_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id VARCHAR(50) NOT NULL,
      row_number INTEGER,
      settlement_id VARCHAR(50),
      item_type VARCHAR(20) NOT NULL,
      reason TEXT,
      raw_data TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (run_id) REFERENCES reconciliation_runs(run_id)
    );

    CREATE INDEX IF NOT EXISTS idx_run_items_run ON reconciliation_run_items(run_id);

    CREATE TABLE IF NOT EXISTS exception_reviews (
      exception_id VARCHAR(100) PRIMARY KEY,
      transaction_id VARCHAR(50),
      issue_code VARCHAR(50) NOT NULL,
      severity VARCHAR(20) NOT NULL,
      review_status VARCHAR(20) DEFAULT 'UNREVIEWED',
      notes TEXT,
      reviewed_by VARCHAR(50) DEFAULT 'Demo Analyst',
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_exception_reviews_txn ON exception_reviews(transaction_id);

    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(50) PRIMARY KEY,
      email VARCHAR(100) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      name VARCHAR(100) NOT NULL,
      role VARCHAR(50) DEFAULT 'admin',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Default admin user check & seed (admin@openfabric.co / admin123)
  try {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare(`
      INSERT OR IGNORE INTO users (id, email, password_hash, name, role)
      VALUES (?, ?, ?, ?, ?)
    `).run('USR_ADMIN_CO', 'admin@openfabric.co', hash, 'Lead Financial Auditor', 'admin');
  } catch (err) {
    // Ignore migration error
  }

  // 2. Safe additive column migrations on existing settlement_history
  try {
    db.exec(`ALTER TABLE settlement_history ADD COLUMN run_id VARCHAR(50);`);
  } catch (err: any) {
    // Column already exists or error ignored
  }

  try {
    db.exec(`ALTER TABLE settlement_history ADD COLUMN match_method VARCHAR(30);`);
  } catch (err: any) {
    // Column already exists or error ignored
  }
}
