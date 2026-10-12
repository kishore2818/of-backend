import { Request, Response } from 'express';
import { getDatabase } from '../db/index.js';
import { ReconciliationService } from '../services/reconciliation.service.js';
import { resetAndSeedDatabase } from '../db/seed.js';
import fs from 'fs';

export class ReconciliationController {
  public static async reconcile(req: Request, res: Response): Promise<void> {
    try {
      let csvContent = '';

      if (req.file) {
        csvContent = req.file.buffer ? req.file.buffer.toString('utf-8') : fs.readFileSync(req.file.path, 'utf-8');
      } else if (req.body && typeof req.body.csv === 'string') {
        csvContent = req.body.csv;
      } else if (typeof req.body === 'string' && req.body.length > 0) {
        csvContent = req.body;
      } else {
        res.status(400).json({
          success: false,
          error: 'No CSV file or CSV text payload provided. Please upload a file via multipart form-data or send CSV text.'
        });
        return;
      }

      const db = getDatabase();
      const reconciliationService = new ReconciliationService(db);
      const result = reconciliationService.reconcileCSV(csvContent);

      res.status(200).json(result);
    } catch (err: any) {
      console.error('Reconciliation error:', err);
      res.status(500).json({
        success: false,
        error: `Internal server error during reconciliation: ${err.message}`
      });
    }
  }

  public static async resetDatabase(req: Request, res: Response): Promise<void> {
    try {
      const db = getDatabase();
      resetAndSeedDatabase(db);
      res.status(200).json({
        success: true,
        message: 'Database reset to initial un-reconciled seed state successfully.'
      });
    } catch (err: any) {
      console.error('Database reset error:', err);
      res.status(500).json({
        success: false,
        error: `Failed to reset database: ${err.message}`
      });
    }
  }
}
