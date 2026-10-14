import { Request, Response } from 'express';
import { getDatabase } from '../db/index.js';
import { ReconciliationService } from '../services/reconciliation.service.js';
import { resetAndSeedDatabase } from '../db/seed.js';
import fs from 'fs';

export class ReconciliationController {
  public static async reconcile(req: Request, res: Response): Promise<void> {
    try {
      let csvContent = '';
      let fileName = 'settlement_upload.csv';
      let fileSizeBytes = 0;

      if (req.file) {
        csvContent = req.file.buffer ? req.file.buffer.toString('utf-8') : fs.readFileSync(req.file.path, 'utf-8');
        fileName = req.file.originalname || fileName;
        fileSizeBytes = req.file.size || Buffer.byteLength(csvContent, 'utf-8');
      } else if (req.body && typeof req.body.csv === 'string') {
        csvContent = req.body.csv;
        fileName = req.body.fileName || 'settlement_pasted.csv';
        fileSizeBytes = Buffer.byteLength(csvContent, 'utf-8');
      } else if (typeof req.body === 'string' && req.body.length > 0) {
        csvContent = req.body;
        fileSizeBytes = Buffer.byteLength(csvContent, 'utf-8');
      } else {
        res.status(400).json({
          success: false,
          error: 'No CSV file or CSV text payload provided. Please upload a file via multipart form-data or send CSV text.'
        });
        return;
      }

      // Max size check: 10MB
      if (fileSizeBytes > 10 * 1024 * 1024) {
        res.status(400).json({
          success: false,
          error: 'File size exceeds maximum allowed upload limit (10MB).'
        });
        return;
      }

      const db = getDatabase();
      const reconciliationService = new ReconciliationService(db);
      const result = reconciliationService.reconcileCSV(csvContent, { fileName, fileSizeBytes });

      res.status(200).json(result);
    } catch (err: any) {
      console.error('Reconciliation error:', err);
      res.status(500).json({
        success: false,
        error: `Internal server error during reconciliation: ${err.message}`
      });
    }
  }

  public static async preview(req: Request, res: Response): Promise<void> {
    try {
      let csvContent = '';
      let fileName = 'settlement_upload.csv';
      let fileSizeBytes = 0;

      if (req.file) {
        csvContent = req.file.buffer ? req.file.buffer.toString('utf-8') : fs.readFileSync(req.file.path, 'utf-8');
        fileName = req.file.originalname || fileName;
        fileSizeBytes = req.file.size || Buffer.byteLength(csvContent, 'utf-8');
      } else if (req.body && typeof req.body.csv === 'string') {
        csvContent = req.body.csv;
        fileName = req.body.fileName || 'settlement_pasted.csv';
        fileSizeBytes = Buffer.byteLength(csvContent, 'utf-8');
      } else if (typeof req.body === 'string' && req.body.length > 0) {
        csvContent = req.body;
        fileSizeBytes = Buffer.byteLength(csvContent, 'utf-8');
      } else {
        res.status(400).json({
          success: false,
          error: 'No CSV file or CSV text payload provided for preview.'
        });
        return;
      }

      const db = getDatabase();
      const reconciliationService = new ReconciliationService(db);
      const previewResult = reconciliationService.previewCSV(csvContent, fileName, fileSizeBytes);

      res.status(200).json(previewResult);
    } catch (err: any) {
      console.error('Preview error:', err);
      res.status(500).json({
        success: false,
        error: `Failed to preview CSV: ${err.message}`
      });
    }
  }

  public static async getRuns(req: Request, res: Response): Promise<void> {
    try {
      const db = getDatabase();
      const reconciliationService = new ReconciliationService(db);
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;

      const result = reconciliationService.getRuns(limit, offset);
      res.status(200).json({
        success: true,
        ...result
      });
    } catch (err: any) {
      console.error('Fetch runs error:', err);
      res.status(500).json({
        success: false,
        error: `Failed to fetch reconciliation runs: ${err.message}`
      });
    }
  }

  public static async getRunById(req: Request, res: Response): Promise<void> {
    try {
      const db = getDatabase();
      const reconciliationService = new ReconciliationService(db);
      const runId = req.params.id;

      const result = reconciliationService.getRunById(runId);
      if (!result) {
        res.status(404).json({
          success: false,
          error: `Reconciliation run "${runId}" not found.`
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: result
      });
    } catch (err: any) {
      console.error('Fetch run by ID error:', err);
      res.status(500).json({
        success: false,
        error: `Failed to fetch run details: ${err.message}`
      });
    }
  }

  public static async exportRejectedItems(req: Request, res: Response): Promise<void> {
    try {
      const db = getDatabase();
      const reconciliationService = new ReconciliationService(db);
      const runId = req.params.id;

      const csvData = reconciliationService.getRejectedItemsCSV(runId);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="reconciliation_${runId}_rejected.csv"`);
      res.status(200).send(csvData);
    } catch (err: any) {
      console.error('Export rejected items error:', err);
      res.status(500).json({
        success: false,
        error: `Failed to export rejected records: ${err.message}`
      });
    }
  }

  public static async deleteRun(req: Request, res: Response): Promise<void> {
    try {
      const db = getDatabase();
      const reconciliationService = new ReconciliationService(db);
      const runId = req.params.id;

      const deleted = reconciliationService.deleteRun(runId);
      if (!deleted) {
        res.status(404).json({
          success: false,
          error: `Reconciliation run "${runId}" not found.`
        });
        return;
      }

      res.status(200).json({
        success: true,
        message: `Reconciliation run "${runId}" and its ingested settlements were deleted successfully.`
      });
    } catch (err: any) {
      console.error('Delete run error:', err);
      res.status(500).json({
        success: false,
        error: `Failed to delete reconciliation run: ${err.message}`
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
