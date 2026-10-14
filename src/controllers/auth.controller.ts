import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getDatabase } from '../db/index.js';
import { config } from '../config/index.js';
import { AuthRequest } from '../middleware/auth.middleware.js';

interface UserRecord {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  role: string;
  created_at: string;
}

export class AuthController {
  static login(req: Request, res: Response): void {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({
        success: false,
        error: 'Email and password are required.'
      });
      return;
    }

    try {
      const db = getDatabase();
      const user = db.prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)').get(email) as UserRecord | undefined;

      if (!user) {
        res.status(401).json({
          success: false,
          error: 'Invalid email credentials.'
        });
        return;
      }

      const isMatch = bcrypt.compareSync(password, user.password_hash);
      if (!isMatch) {
        res.status(401).json({
          success: false,
          error: 'Invalid password.'
        });
        return;
      }

      const payload = {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role
      };

      const token = jwt.sign(payload, config.jwtSecret, {
        expiresIn: config.jwtExpiry as any
      });

      res.status(200).json({
        success: true,
        message: 'Login successful',
        token,
        user: payload
      });
    } catch (err: any) {
      console.error('Login error:', err);
      res.status(500).json({
        success: false,
        error: 'Internal authentication error: ' + err.message
      });
    }
  }

  static getProfile(req: AuthRequest, res: Response): void {
    if (!req.user) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    try {
      const db = getDatabase();
      const user = db.prepare('SELECT id, email, name, role, created_at FROM users WHERE id = ?').get(req.user.id);
      if (!user) {
        res.status(404).json({ success: false, error: 'User record not found.' });
        return;
      }
      res.status(200).json({
        success: true,
        user
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
}
