import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const config = {
  port: parseInt(process.env.PORT || '4000', 10),
  dbPath: process.env.DB_PATH || path.resolve(process.cwd(), 'data/reconciliation.db'),
  defaultEvaluationDate: process.env.EVALUATION_DATE || '2025-08-15',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  jwtSecret: process.env.JWT_SECRET || 'openfabric_reconciliation_super_secure_jwt_secret_2026',
  jwtExpiry: process.env.JWT_EXPIRY || '24h'
};
