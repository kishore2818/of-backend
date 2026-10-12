import { Router } from 'express';
import { DashboardController } from '../controllers/dashboard.controller.js';

export const dashboardRouter = Router();

dashboardRouter.get('/dashboard/summary', DashboardController.getSummary);
