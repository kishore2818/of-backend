import { Request, Response } from 'express';
import { getDatabase } from '../db/index.js';
import { DashboardService } from '../services/dashboard.service.js';
import { config } from '../config/index.js';

export class DashboardController {
  public static async getSummary(req: Request, res: Response): Promise<void> {
    try {
      const db = getDatabase();
      const dashboardService = new DashboardService(db);
      const rawDate = req.query.evaluationDate as string;
      const evaluationDate = (rawDate && rawDate.trim() !== '') ? rawDate.trim() : undefined;
      const rawRunId = req.query.runId as string | undefined;

      const summary = dashboardService.getSummary(evaluationDate, rawRunId);

      res.status(200).json({
        success: true,
        evaluationDate: summary.latestDate,
        data: summary
      });
    } catch (err: any) {
      console.error('Dashboard summary error:', err);
      res.status(500).json({
        success: false,
        error: `Failed to retrieve dashboard summary: ${err.message}`
      });
    }
  }
}
