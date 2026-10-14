import { Router } from 'express';
import { TransactionController } from '../controllers/transaction.controller.js';

export const transactionRouter = Router();

transactionRouter.get('/transactions', TransactionController.getAll);
transactionRouter.get('/transactions/export', TransactionController.exportCsv);
transactionRouter.get('/settlements', TransactionController.getAllSettlements);
transactionRouter.get('/transactions/:id', TransactionController.getById);
transactionRouter.get('/transactions/:id/export-settlements', TransactionController.exportTransactionSettlements);
