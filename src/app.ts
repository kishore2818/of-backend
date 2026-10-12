import express from 'express';
import cors from 'cors';
import { reconciliationRouter } from './routes/reconciliation.routes.js';
import { transactionRouter } from './routes/transaction.routes.js';
import { dashboardRouter } from './routes/dashboard.routes.js';

export function createApp(): express.Application {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Health check
  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Mount API routers
  app.use(reconciliationRouter);
  app.use(transactionRouter);
  app.use(dashboardRouter);

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({
      success: false,
      error: `Endpoint not found: ${req.method} ${req.path}`
    });
  });

  return app;
}
