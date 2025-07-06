import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { UsageRecord } from './types';

/**
 * Database manager for usage logging
 * Uses better-sqlite3 for synchronous, high-performance SQLite operations
 */
export class DatabaseManager {
  private db: Database.Database;

  constructor(dbPath: string = 'usage.db') {
    // Ensure the directory exists before creating the database
    const dbDir = path.dirname(dbPath);
    if (dbDir !== '.' && !fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    
    this.db = new Database(dbPath);
    this.init();
  }

  /**
   * Initialize database schema
   */
  private init(): void {
    // Create usage table for logging all API requests
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        tz TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        format INTEGER NOT NULL,
        conf REAL NOT NULL,
        ip TEXT NOT NULL,
        ts DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create index for performance
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage(ts);
      CREATE INDEX IF NOT EXISTS idx_usage_format ON usage(format);
      CREATE INDEX IF NOT EXISTS idx_usage_ip ON usage(ip);
    `);

    console.log('Database initialized successfully');
  }

  /**
   * Log a usage record
   */
  public logUsage(record: Omit<UsageRecord, 'id' | 'ts'>): void {
    const stmt = this.db.prepare(`
      INSERT INTO usage (text, tz, epoch, format, conf, ip)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    try {
      stmt.run(
        record.text,
        record.tz,
        record.epoch,
        record.format,
        record.conf,
        record.ip
      );
    } catch (error) {
      console.error('Error logging usage:', error);
      // Don't throw - logging failures shouldn't break the API
    }
  }

  /**
   * Get usage statistics (for debugging/monitoring)
   */
  public getUsageStats(): {
    total: number;
    byFormat: Record<number, number>;
    last24h: number;
  } {
    try {
      // Total requests
      const totalStmt = this.db.prepare('SELECT COUNT(*) as count FROM usage');
      const totalResult = totalStmt.get() as { count: number };
      const total = totalResult.count;

      // By format
      const formatStmt = this.db.prepare(`
        SELECT format, COUNT(*) as count 
        FROM usage 
        GROUP BY format
      `);
      const formatResults = formatStmt.all() as { format: number; count: number }[];
      const byFormat: Record<number, number> = {};
      formatResults.forEach(row => {
        byFormat[row.format] = row.count;
      });

      // Last 24h
      const last24hStmt = this.db.prepare(`
        SELECT COUNT(*) as count 
        FROM usage 
        WHERE ts > datetime('now', '-24 hours')
      `);
      const last24hResult = last24hStmt.get() as { count: number };
      const last24h = last24hResult.count;

      return { total, byFormat, last24h };
    } catch (error) {
      console.error('Error getting usage stats:', error);
      return { total: 0, byFormat: {}, last24h: 0 };
    }
  }

  /**
   * Get recent usage records (for debugging)
   */
  public getRecentUsage(limit: number = 10): UsageRecord[] {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM usage 
        ORDER BY ts DESC 
        LIMIT ?
      `);
      return stmt.all(limit) as UsageRecord[];
    } catch (error) {
      console.error('Error getting recent usage:', error);
      return [];
    }
  }

  /**
   * Close database connection
   */
  public close(): void {
    this.db.close();
  }

  /**
   * Get database info
   */
  public getInfo(): { size: number; tables: string[] } {
    try {
      const pragma = this.db.pragma('page_size') as number;
      const pageCount = this.db.pragma('page_count') as number;
      const size = pragma * pageCount;

      const tables = this.db.prepare(`
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name NOT LIKE 'sqlite_%'
      `).all() as { name: string }[];

      return {
        size,
        tables: tables.map(t => t.name)
      };
    } catch (error) {
      console.error('Error getting database info:', error);
      return { size: 0, tables: [] };
    }
  }
}

// Lazy singleton instance
let _dbInstance: DatabaseManager | null = null;

export function getDatabase(dbPath?: string): DatabaseManager {
  if (!_dbInstance) {
    _dbInstance = new DatabaseManager(dbPath);
  }
  return _dbInstance;
}

// Export as db for backward compatibility
export const db = {
  logUsage: (record: Omit<UsageRecord, 'id' | 'ts'>) => getDatabase().logUsage(record),
  getUsageStats: () => getDatabase().getUsageStats(),
  getRecentUsage: (limit?: number) => getDatabase().getRecentUsage(limit),
  getInfo: () => getDatabase().getInfo(),
  close: () => _dbInstance?.close()
}; 