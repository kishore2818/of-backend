import { Request, Response } from 'express';
import { getDatabase } from '../db/index.js';
import { ExceptionService } from '../services/exception.service.js';

export class ExceptionController {
  public static async getAll(req: Request, res: Response): Promise<void> {
    try {
      const db = getDatabase();
      const exceptionService = new ExceptionService(db);

      const severity = req.query.severity as string;
      const reviewStatus = req.query.reviewStatus as string;
      const issueType = req.query.issueType as string;
      const search = req.query.search as string;
      const evaluationDate = req.query.evaluationDate as string;

      const result = exceptionService.getExceptions({
        severity,
        reviewStatus,
        issueType,
        search,
        evaluationDate
      });

      res.status(200).json({
        success: true,
        ...result
      });
    } catch (err: any) {
      console.error('Fetch exceptions error:', err);
      res.status(500).json({
        success: false,
        error: `Failed to fetch exceptions: ${err.message}`
      });
    }
  }

  public static async getById(req: Request, res: Response): Promise<void> {
    try {
      const db = getDatabase();
      const exceptionService = new ExceptionService(db);
      const exceptionId = req.params.id;

      const result = exceptionService.getExceptionById(exceptionId);
      if (!result) {
        res.status(404).json({
          success: false,
          error: `Exception with ID "${exceptionId}" not found.`
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: result
      });
    } catch (err: any) {
      console.error('Fetch exception details error:', err);
      res.status(500).json({
        success: false,
        error: `Failed to fetch exception details: ${err.message}`
      });
    }
  }

  public static async updateReview(req: Request, res: Response): Promise<void> {
    try {
      const db = getDatabase();
      const exceptionService = new ExceptionService(db);
      const exceptionId = req.params.id;
      const { reviewStatus, notes, reviewedBy } = req.body;

      if (!reviewStatus) {
        res.status(400).json({
          success: false,
          error: 'reviewStatus is required ("UNREVIEWED", "UNDER_REVIEW", or "RESOLVED").'
        });
        return;
      }

      const updated = exceptionService.updateReview(exceptionId, {
        reviewStatus,
        notes,
        reviewedBy
      });

      res.status(200).json({
        success: true,
        message: 'Exception review state updated successfully.',
        data: updated
      });
    } catch (err: any) {
      console.error('Update review error:', err);
      res.status(500).json({
        success: false,
        error: `Failed to update exception review: ${err.message}`
      });
    }
  }

  public static async exportCsv(req: Request, res: Response): Promise<void> {
    try {
      const db = getDatabase();
      const exceptionService = new ExceptionService(db);

      const severity = req.query.severity as string;
      const reviewStatus = req.query.reviewStatus as string;
      const search = req.query.search as string;

      const csvData = exceptionService.exportExceptionsCSV({
        severity,
        reviewStatus,
        search
      });

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="exceptions_report.csv"');
      res.status(200).send(csvData);
    } catch (err: any) {
      console.error('Export exceptions error:', err);
      res.status(500).json({
        success: false,
        error: `Failed to export exceptions CSV: ${err.message}`
      });
    }
  }
}
