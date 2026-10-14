import { Router } from 'express';
import { AuthController } from '../controllers/auth.controller.js';
import { authMiddleware } from '../middleware/auth.middleware.js';

export const authRouter = Router();

authRouter.post('/auth/login', AuthController.login);
authRouter.get('/auth/me', authMiddleware as any, AuthController.getProfile as any);
