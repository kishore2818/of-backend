import { createApp } from './app.js';
import { config } from './config/index.js';
import { getDatabase } from './db/index.js';

const app = createApp();

// Verify database connectivity on startup
try {
  const db = getDatabase();
  const count = db.prepare('SELECT COUNT(*) as count FROM transactions').get() as { count: number };
  console.log(`Database connected successfully at ${config.dbPath}. Loaded ${count.count} transactions.`);
} catch (err: any) {
  console.error('Failed to initialize database on startup:', err);
  process.exit(1);
}

app.listen(config.port, () => {
  console.log(`Transaction Reconciliation Backend running on http://localhost:${config.port}`);
});
