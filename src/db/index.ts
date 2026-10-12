import Database from 'better-sqlite3';
import { config } from '../config/index.js';
import fs from 'fs';
import path from 'path';

let dbInstance: Database.Database | null = null;

export function getDatabase(customPath?: string): Database.Database {
  if (customPath) {
    const db = new Database(customPath);
    db.pragma('foreign_keys = ON');
    return db;
  }

  if (!dbInstance) {
    const dbPath = config.dbPath;
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    dbInstance = new Database(dbPath);
    dbInstance.pragma('foreign_keys = ON');
  }

  return dbInstance;
}

export function setDatabaseInstance(db: Database.Database | null): void {
  dbInstance = db;
}

export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
