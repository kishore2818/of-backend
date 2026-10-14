import { Router } from 'express';
import { TransactionController } from '../controllers/transaction.controller.js';

export const transactionRouter = Router();

transactionRouter.get('/transactions', TransactionController.getAll);
transactionRouter.post('/transactions', TransactionController.createTransaction);
transactionRouter.post('/transactions/bulk', TransactionController.bulkCreateTransactions);
transactionRouter.get('/transactions/export', TransactionController.exportCsv);
transactionRouter.get('/settlements', TransactionController.getAllSettlements);
transactionRouter.get('/transactions/:id', TransactionController.getById);
transactionRouter.put('/transactions/:id', TransactionController.updateTransaction);
transactionRouter.patch('/transactions/:id', TransactionController.updateTransaction);
transactionRouter.delete('/transactions/:id', TransactionController.deleteTransaction);
transactionRouter.get('/transactions/:id/export-settlements', TransactionController.exportTransactionSettlements);
