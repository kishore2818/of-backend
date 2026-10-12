import { Request, Response } from 'express';
import { getDatabase } from '../db/index.js';
import { DashboardService } from '../services/dashboard.service.js';
import { config } from '../config/index.js';

export class DashboardController {
  public static async getSummary(req: Request, res: Response): Promise<void> {
    try {
      const db = getDatabase();
      const dashboardService = new DashboardService(db);
      const evaluationDate = (req.query.evaluationDate as string) || config.defaultEvaluationDate;

      const summary = dashboardService.getSummary(evaluationDate);

      res.status(200).json({
        success: true,
        evaluationDate,
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
