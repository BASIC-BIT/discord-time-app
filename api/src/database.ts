import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { GenerationOutcomeRecord, GenerationRecord, UsageRecord } from './types';

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

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS temporal_generations (
        generation_id TEXT PRIMARY KEY,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        surface TEXT NOT NULL,
        flow_version TEXT NOT NULL,
        request_time_zone TEXT NOT NULL,
        reference_instant TEXT NOT NULL,
        input_text_hash TEXT NOT NULL,
        input_text_retained INTEGER NOT NULL DEFAULT 0,
        input_text TEXT,
        final_status TEXT NOT NULL,
        final_method TEXT NOT NULL,
        final_epoch INTEGER,
        candidate_count INTEGER,
        clarification_alternative_count INTEGER,
        total_duration_ms INTEGER,
        error_class TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_temporal_generations_created_at ON temporal_generations(created_at);
      CREATE INDEX IF NOT EXISTS idx_temporal_generations_status ON temporal_generations(final_status);
      CREATE INDEX IF NOT EXISTS idx_temporal_generations_hash ON temporal_generations(input_text_hash);

      CREATE TABLE IF NOT EXISTS temporal_generation_outcomes (
        outcome_id INTEGER PRIMARY KEY AUTOINCREMENT,
        generation_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        action TEXT NOT NULL,
        selected_format_index INTEGER,
        feedback_category TEXT,
        FOREIGN KEY (generation_id) REFERENCES temporal_generations(generation_id)
      );

      CREATE INDEX IF NOT EXISTS idx_temporal_generation_outcomes_generation_id ON temporal_generation_outcomes(generation_id);
      CREATE INDEX IF NOT EXISTS idx_temporal_generation_outcomes_action ON temporal_generation_outcomes(action);
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

  public logGeneration(record: GenerationRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO temporal_generations (
        generation_id,
        surface,
        flow_version,
        request_time_zone,
        reference_instant,
        input_text_hash,
        input_text_retained,
        input_text,
        final_status,
        final_method,
        final_epoch,
        candidate_count,
        clarification_alternative_count,
        total_duration_ms,
        error_class
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(generation_id) DO UPDATE SET
        final_status = excluded.final_status,
        final_method = excluded.final_method,
        final_epoch = excluded.final_epoch,
        candidate_count = excluded.candidate_count,
        clarification_alternative_count = excluded.clarification_alternative_count,
        total_duration_ms = excluded.total_duration_ms,
        error_class = excluded.error_class
    `);

    try {
      stmt.run(
        record.generationId,
        record.surface,
        record.flowVersion,
        record.requestTimeZone,
        record.referenceInstant,
        record.inputTextHash,
        record.inputTextRetained ? 1 : 0,
        record.inputText ?? null,
        record.finalStatus,
        record.finalMethod,
        record.finalEpoch ?? null,
        record.candidateCount ?? null,
        record.clarificationAlternativeCount ?? null,
        record.totalDurationMs ?? null,
        record.errorClass ?? null,
      );
    } catch (error) {
      console.error('Error logging generation:', error);
    }
  }

  public logGenerationOutcome(record: GenerationOutcomeRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO temporal_generation_outcomes (generation_id, action, selected_format_index, feedback_category)
      VALUES (?, ?, ?, ?)
    `);

    try {
      stmt.run(
        record.generationId,
        record.action,
        record.selectedFormatIndex ?? null,
        record.feedbackCategory ?? null,
      );
    } catch (error) {
      console.error('Error logging generation outcome:', error);
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
  logGeneration: (record: GenerationRecord) => getDatabase().logGeneration(record),
  logGenerationOutcome: (record: GenerationOutcomeRecord) => getDatabase().logGenerationOutcome(record),
  getUsageStats: () => getDatabase().getUsageStats(),
  getRecentUsage: (limit?: number) => getDatabase().getRecentUsage(limit),
  getInfo: () => getDatabase().getInfo(),
  close: () => _dbInstance?.close()
};
