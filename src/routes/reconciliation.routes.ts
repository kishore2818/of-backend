import { Router } from 'express';
import multer from 'multer';
import { ReconciliationController } from '../controllers/reconciliation.controller.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

export const reconciliationRouter = Router();

reconciliationRouter.post('/reconcile', upload.single('file'), ReconciliationController.reconcile);
reconciliationRouter.post('/reconcile/reset', ReconciliationController.resetDatabase);
