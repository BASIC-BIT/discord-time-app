import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DatabaseManager } from '../src/database';

const tempDirectory = mkdtempSync(path.join(tmpdir(), 'hammertime-routing-db-'));
const databasePath = path.join(tempDirectory, 'usage.db');

try {
  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      tz TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      format INTEGER NOT NULL,
      conf REAL NOT NULL,
      ip TEXT NOT NULL,
      ts DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO usage (text, tz, epoch, format, conf, ip)
    VALUES ('sensitive legacy prose', 'UTC', 1, 4, 1, '127.0.0.1');
    INSERT INTO usage (text, tz, epoch, format, conf, ip, ts)
    VALUES ('expired sensitive prose', 'UTC', 1, 4, 1, '127.0.0.1', '2020-01-01 00:00:00');

    CREATE TABLE temporal_generations (
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
    INSERT INTO temporal_generations (
      generation_id,
      created_at,
      surface,
      flow_version,
      request_time_zone,
      reference_instant,
      input_text_hash,
      input_text_retained,
      final_status,
      final_method
    ) VALUES (
      'tp_expired',
      '2020-01-01 00:00:00',
      'smoke',
      'legacy',
      'UTC',
      '2020-01-01T00:00:00Z',
      'legacy-hash',
      0,
      'failed',
      'legacy'
    );
  `);
  legacy.close();

  const manager = new DatabaseManager(databasePath);
  assert.equal(manager.getRecentUsage(1)[0]?.text, '[redacted]');
  assert.equal(manager.getRecentUsage(1)[0]?.ip, '[redacted]');
  assert.equal(manager.getRecentUsage(10).length, 1);

  manager.logUsage({
    text: 'new sensitive prose',
    tz: 'UTC',
    epoch: 2,
    format: 2,
    conf: 1,
    ip: '127.0.0.1',
  });
  assert.equal(manager.getRecentUsage(2).every((row) => row.text === '[redacted]' && row.ip === '[redacted]'), true);

  manager.logGeneration({
    generationId: 'tp_database_smoke',
    surface: 'smoke',
    flowVersion: 'temporal-cascade-v1',
    requestTimeZone: 'UTC',
    referenceInstant: '2026-07-27T00:00:00Z',
    inputTextHash: 'test-key:test-digest',
    inputTextRetained: false,
    finalStatus: 'resolved',
    finalMethod: 'agent+plan',
    finalEpoch: 1785646800,
    candidateCount: 1,
    clarificationAlternativeCount: 0,
    totalDurationMs: 3,
    firstCorrectDurationMs: 2,
    classifierVersion: 'discord-reference-v2',
    route: 'model',
    routeReason: 'semantic_residue_requires_model',
    referenceCount: 1,
    malformedCount: 0,
    contextClass: 'plain',
    inputLengthBucket: '0-64',
    shadow: false,
    legacyFirstMatchWouldResolve: true,
    legacyFirstMatchWouldDiffer: true,
    modelName: 'temporal-model-smoke',
    planOperations: 'resolve_calendar_query,shift_datetime',
    modelCalls: 1,
    inputTokens: 120,
    outputTokens: 40,
    estimatedCostUsd: 0.00016,
    costEstimateConfigured: true,
    validationPassed: true,
    fallbackReason: 'model_plan_resolved',
  });

  const routingStats = manager.getReferenceRoutingStats();
  assert.equal(routingStats.last24h.total, 1);
  assert.equal(routingStats.byRoute[0]?.route, 'model');
  assert.equal(routingStats.byRoute[0]?.count, 1);
  assert.equal(routingStats.last24h.legacyDecisionDifferences, 1);
  manager.close();

  const inspection = new Database(databasePath, { readonly: true });
  const generation = inspection.prepare(`
    SELECT input_text, route, input_tokens, validation_passed, fallback_reason
    FROM temporal_generations
    WHERE generation_id = ?
  `).get('tp_database_smoke') as {
    input_text: string | null;
    route: string;
    input_tokens: number;
    validation_passed: number;
    fallback_reason: string;
  };
  assert.equal(generation.input_text, null);
  assert.equal(generation.route, 'model');
  assert.equal(generation.input_tokens, 120);
  assert.equal(generation.validation_passed, 1);
  assert.equal(generation.fallback_reason, 'model_plan_resolved');
  const expiredGeneration = inspection.prepare(`
    SELECT generation_id
    FROM temporal_generations
    WHERE generation_id = 'tp_expired'
  `).get();
  assert.equal(expiredGeneration, undefined);
  inspection.close();
} finally {
  rmSync(tempDirectory, { recursive: true, force: true });
}
