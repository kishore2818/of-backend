import { Router } from 'express';
import multer from 'multer';
import { ReconciliationController } from '../controllers/reconciliation.controller.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

export const reconciliationRouter = Router();

// Ingestion and Preview
reconciliationRouter.post('/reconcile', upload.single('file'), ReconciliationController.reconcile);
reconciliationRouter.post('/reconcile/preview', upload.single('file'), ReconciliationController.preview);
reconciliationRouter.post('/reconcile/reset', ReconciliationController.resetDatabase);

// Reconciliation Runs Audit & History
reconciliationRouter.get('/reconciliation-runs', ReconciliationController.getRuns);
reconciliationRouter.get('/reconciliation-runs/:id', ReconciliationController.getRunById);
reconciliationRouter.delete('/reconciliation-runs/:id', ReconciliationController.deleteRun);
reconciliationRouter.get('/reconciliation-runs/:id/export-rejected', ReconciliationController.exportRejectedItems);
