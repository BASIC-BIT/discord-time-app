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

  constructor(dbPath: string = 'usage.db', private readonly retentionDays: number = 30) {
    // Ensure the directory exists before creating the database
    const dbDir = path.dirname(dbPath);
    if (dbDir !== '.' && !fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    
    this.db = new Database(dbPath);
    this.db.pragma('foreign_keys = ON');
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
        first_correct_duration_ms INTEGER,
        error_class TEXT,
        classifier_version TEXT,
        route TEXT,
        route_reason TEXT,
        reference_count INTEGER,
        malformed_count INTEGER,
        context_class TEXT,
        input_length_bucket TEXT,
        shadow INTEGER,
        legacy_first_match_would_resolve INTEGER,
        legacy_first_match_would_differ INTEGER,
        model_name TEXT,
        plan_operations TEXT,
        model_calls INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        estimated_cost_usd REAL,
        cost_estimate_configured INTEGER,
        validation_passed INTEGER,
        fallback_reason TEXT
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

    this.ensureTemporalGenerationColumns();
    this.db.prepare(`UPDATE usage SET text = '[redacted]', ip = '[redacted]' WHERE text <> '[redacted]' OR ip <> '[redacted]'`).run();
    this.applyTelemetryRetention();
    console.log('Database initialized successfully');
  }

  private applyTelemetryRetention(): void {
    const modifier = `-${this.retentionDays} days`;
    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        DELETE FROM temporal_generation_outcomes
        WHERE generation_id IN (
          SELECT generation_id
          FROM temporal_generations
          WHERE created_at < datetime('now', ?)
        )
      `).run(modifier);
      this.db.prepare(`DELETE FROM temporal_generations WHERE created_at < datetime('now', ?)`).run(modifier);
      this.db.prepare(`DELETE FROM usage WHERE ts < datetime('now', ?)`).run(modifier);
    });
    transaction();
  }

  private ensureTemporalGenerationColumns(): void {
    const columns: Array<[string, string]> = [
      ['classifier_version', 'TEXT'],
      ['route', 'TEXT'],
      ['route_reason', 'TEXT'],
      ['reference_count', 'INTEGER'],
      ['malformed_count', 'INTEGER'],
      ['context_class', 'TEXT'],
      ['input_length_bucket', 'TEXT'],
      ['shadow', 'INTEGER'],
      ['legacy_first_match_would_resolve', 'INTEGER'],
      ['legacy_first_match_would_differ', 'INTEGER'],
      ['model_name', 'TEXT'],
      ['plan_operations', 'TEXT'],
      ['first_correct_duration_ms', 'INTEGER'],
      ['model_calls', 'INTEGER'],
      ['input_tokens', 'INTEGER'],
      ['output_tokens', 'INTEGER'],
      ['estimated_cost_usd', 'REAL'],
      ['cost_estimate_configured', 'INTEGER'],
      ['validation_passed', 'INTEGER'],
      ['fallback_reason', 'TEXT'],
    ];
    const existing = new Set(
      (this.db.prepare(`PRAGMA table_info(temporal_generations)`).all() as Array<{ name: string }>)
        .map((column) => column.name),
    );
    for (const [name, type] of columns) {
      if (!existing.has(name)) {
        this.db.exec(`ALTER TABLE temporal_generations ADD COLUMN ${name} ${type}`);
      }
    }
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
        '[redacted]',
        record.tz,
        record.epoch,
        record.format,
        record.conf,
        '[redacted]'
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
        first_correct_duration_ms,
        error_class,
        classifier_version,
        route,
        route_reason,
        reference_count,
        malformed_count,
        context_class,
        input_length_bucket,
        shadow,
        legacy_first_match_would_resolve,
        legacy_first_match_would_differ,
        model_name,
        plan_operations,
        model_calls,
        input_tokens,
        output_tokens,
        estimated_cost_usd,
        cost_estimate_configured,
        validation_passed,
        fallback_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(generation_id) DO UPDATE SET
        final_status = excluded.final_status,
        final_method = excluded.final_method,
        final_epoch = excluded.final_epoch,
        candidate_count = excluded.candidate_count,
        clarification_alternative_count = excluded.clarification_alternative_count,
        total_duration_ms = excluded.total_duration_ms,
        first_correct_duration_ms = excluded.first_correct_duration_ms,
        error_class = excluded.error_class,
        classifier_version = excluded.classifier_version,
        route = excluded.route,
        route_reason = excluded.route_reason,
        reference_count = excluded.reference_count,
        malformed_count = excluded.malformed_count,
        context_class = excluded.context_class,
        input_length_bucket = excluded.input_length_bucket,
        shadow = excluded.shadow,
        legacy_first_match_would_resolve = excluded.legacy_first_match_would_resolve,
        legacy_first_match_would_differ = excluded.legacy_first_match_would_differ,
        model_name = excluded.model_name,
        plan_operations = excluded.plan_operations,
        model_calls = excluded.model_calls,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        estimated_cost_usd = excluded.estimated_cost_usd,
        cost_estimate_configured = excluded.cost_estimate_configured,
        validation_passed = excluded.validation_passed,
        fallback_reason = excluded.fallback_reason
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
        record.firstCorrectDurationMs ?? null,
        record.errorClass ?? null,
        record.classifierVersion ?? null,
        record.route ?? null,
        record.routeReason ?? null,
        record.referenceCount ?? null,
        record.malformedCount ?? null,
        record.contextClass ?? null,
        record.inputLengthBucket ?? null,
        record.shadow === undefined ? null : record.shadow ? 1 : 0,
        record.legacyFirstMatchWouldResolve === undefined ? null : record.legacyFirstMatchWouldResolve ? 1 : 0,
        record.legacyFirstMatchWouldDiffer === undefined ? null : record.legacyFirstMatchWouldDiffer ? 1 : 0,
        record.modelName ?? null,
        record.planOperations ?? null,
        record.modelCalls ?? null,
        record.inputTokens ?? null,
        record.outputTokens ?? null,
        record.estimatedCostUsd ?? null,
        record.costEstimateConfigured === undefined ? null : record.costEstimateConfigured ? 1 : 0,
        record.validationPassed === undefined ? null : record.validationPassed ? 1 : 0,
        record.fallbackReason ?? null,
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

  public getReferenceRoutingStats(): {
    last24h: {
      total: number;
      modelCalls: number;
      inputTokens: number;
      outputTokens: number;
      estimatedCostUsd: number;
      costConfiguredRecords: number;
      legacyDecisionDifferences: number;
      projected30DayCostUsd: number;
    };
    byRoute: Array<{
      route: string;
      count: number;
      averageDurationMs: number;
      maxDurationMs: number;
      modelCalls: number;
      estimatedCostUsd: number;
    }>;
  } {
    try {
      const totals = this.db.prepare(`
        SELECT
          COUNT(*) AS total,
          COALESCE(SUM(model_calls), 0) AS modelCalls,
          COALESCE(SUM(input_tokens), 0) AS inputTokens,
          COALESCE(SUM(output_tokens), 0) AS outputTokens,
          COALESCE(SUM(estimated_cost_usd), 0) AS estimatedCostUsd,
          COALESCE(SUM(CASE WHEN cost_estimate_configured = 1 THEN 1 ELSE 0 END), 0) AS costConfiguredRecords,
          COALESCE(SUM(CASE WHEN legacy_first_match_would_differ = 1 THEN 1 ELSE 0 END), 0) AS legacyDecisionDifferences
        FROM temporal_generations
        WHERE created_at > datetime('now', '-24 hours')
      `).get() as {
        total: number;
        modelCalls: number;
        inputTokens: number;
        outputTokens: number;
        estimatedCostUsd: number;
        costConfiguredRecords: number;
        legacyDecisionDifferences: number;
      };
      const byRoute = this.db.prepare(`
        SELECT
          COALESCE(route, 'unclassified') AS route,
          COUNT(*) AS count,
          COALESCE(AVG(total_duration_ms), 0) AS averageDurationMs,
          COALESCE(MAX(total_duration_ms), 0) AS maxDurationMs,
          COALESCE(SUM(model_calls), 0) AS modelCalls,
          COALESCE(SUM(estimated_cost_usd), 0) AS estimatedCostUsd
        FROM temporal_generations
        WHERE created_at > datetime('now', '-24 hours')
        GROUP BY COALESCE(route, 'unclassified')
        ORDER BY count DESC, route ASC
      `).all() as Array<{
        route: string;
        count: number;
        averageDurationMs: number;
        maxDurationMs: number;
        modelCalls: number;
        estimatedCostUsd: number;
      }>;
      return {
        last24h: {
          ...totals,
          projected30DayCostUsd: totals.estimatedCostUsd * 30,
        },
        byRoute,
      };
    } catch (error) {
      console.error('Error getting reference routing stats:', error);
      return {
        last24h: {
          total: 0,
          modelCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0,
          costConfiguredRecords: 0,
          legacyDecisionDifferences: 0,
          projected30DayCostUsd: 0,
        },
        byRoute: [],
      };
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

export function getDatabase(dbPath?: string, retentionDays?: number): DatabaseManager {
  if (!_dbInstance) {
    _dbInstance = new DatabaseManager(dbPath, retentionDays);
  }
  return _dbInstance;
}

// Export as db for backward compatibility
export const db = {
  logUsage: (record: Omit<UsageRecord, 'id' | 'ts'>) => getDatabase().logUsage(record),
  logGeneration: (record: GenerationRecord) => getDatabase().logGeneration(record),
  logGenerationOutcome: (record: GenerationOutcomeRecord) => getDatabase().logGenerationOutcome(record),
  getUsageStats: () => getDatabase().getUsageStats(),
  getReferenceRoutingStats: () => getDatabase().getReferenceRoutingStats(),
  getRecentUsage: (limit?: number) => getDatabase().getRecentUsage(limit),
  getInfo: () => getDatabase().getInfo(),
  close: () => _dbInstance?.close()
};
