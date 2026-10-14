import { Router } from 'express';
import { ExceptionController } from '../controllers/exception.controller.js';

export const exceptionRouter = Router();

exceptionRouter.get('/exceptions', ExceptionController.getAll);
exceptionRouter.get('/exceptions/export', ExceptionController.exportCsv);
exceptionRouter.get('/exceptions/:id', ExceptionController.getById);
exceptionRouter.patch('/exceptions/:id/review', ExceptionController.updateReview);
