import { createApp } from './app.js';
import { config } from './config/index.js';
import { getDatabase } from './db/index.js';
import { runMigrations } from './db/migrations.js';

const app = createApp();

// Verify database connectivity and schema initialization on startup
try {
  let db = getDatabase();
  
  // Always run migrations to ensure all tables (including users) are created
  runMigrations(db);

  // Check if transactions table exists
  const tableCheck = db.prepare(
    "SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='transactions'"
  ).get() as { count: number };
  
  let count = { count: 0 };
  if (tableCheck.count === 0) {
    console.log('Database tables missing. Running initial schema setup and seed...');
    const { resetAndSeedDatabase } = await import('./db/seed.js');
    resetAndSeedDatabase(db);
    count = db.prepare('SELECT COUNT(*) as count FROM transactions').get() as { count: number };
  } else {
    count = db.prepare('SELECT COUNT(*) as count FROM transactions').get() as { count: number };
    if (count.count === 0) {
      console.log('Database empty. Running seed to load standard 14 transactions...');
      const { resetAndSeedDatabase } = await import('./db/seed.js');
      resetAndSeedDatabase(db);
      count = db.prepare('SELECT COUNT(*) as count FROM transactions').get() as { count: number };
    }
  }
  
  console.log(`Database connected successfully at ${config.dbPath}. Loaded ${count.count} transactions.`);
} catch (err: any) {
  console.error('Failed to initialize database on startup:', err);
  process.exit(1);
}

app.listen(config.port, () => {
  console.log(`Transaction Reconciliation Backend running on http://localhost:${config.port}`);
});
