import 'dotenv/config'; // Load .env file
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { Temporal } from '@js-temporal/polyfill';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { ParseOutcomeRequest, ParseRequest, ParseVerificationRequest, ErrorResponse, API_VERSION, REQUIRED_HEADERS } from './types';
import { config } from './config';
import { db, getDatabase } from './database';
import { parseTemporalExpression } from './temporal';
import { parseCalendarContext } from './temporal/deterministic';
import { verifyTemporalParseResponseWithSemanticConsistencyGate } from './temporal/graph';
import { createDeterministicTemporalToolImplementations } from './temporal/tools';
import type { Candidate, TemporalParseResponse, Weekday } from './temporal/types';

/**
 * Create Fastify server instance
 */
// Create logger configuration that handles missing pino-pretty
function createLoggerConfig() {
  if (process.env['NODE_ENV'] === 'production') {
    return { level: 'info' }; // Simple JSON logging in production
  }
  
  try {
    require.resolve('pino-pretty');
    return {
      level: 'info',
      transport: {
        target: 'pino-pretty',
        options: {
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname',
        },
      },
    };
  } catch {
    return { level: 'info' }; // Fallback to simple logging
  }
}

const server = Fastify({
  logger: createLoggerConfig(),
  trustProxy: true,
});

const apiStartedAt = new Date().toISOString();
const apiEntrypoint = process.argv[1];
const apiRuntime = {
  startedAt: apiStartedAt,
  pid: process.pid,
  nodeVersion: process.version,
  entrypoint: apiEntrypoint,
  entrypointMtime: fileMtimeIso(apiEntrypoint),
  cwd: process.cwd(),
  mode: inferRuntimeMode(apiEntrypoint),
};

const ISO_INSTANT_PATTERN = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,9})?)?(?:[zZ]|[+-]\\d{2}:\\d{2})$';
const isoInstantPattern = new RegExp(ISO_INSTANT_PATTERN);

const CORS_ORIGINS = ['http://localhost:1420', 'tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'];

server.addHook('onRequest', async (request, reply) => {
  if (CORS_ORIGINS.includes(request.headers.origin ?? '')) {
    reply.header('Access-Control-Allow-Private-Network', 'true');
  }
});

/**
 * Register CORS plugin
 */
server.register(cors, {
  origin: CORS_ORIGINS,
  credentials: true,
  allowedHeaders: ['Content-Type', 'x-api-key', 'x-api-version']
});

/**
 * Register rate limiting plugin
 */
server.register(rateLimit, {
  max: 60,
  timeWindow: '1 minute',
  errorResponseBuilder: (_req, context) => {
    const error: ErrorResponse = {
      error: 'rate_limited',
      message: `Rate limit exceeded, retry in ${context.ttl} seconds`
    };
    return error;
  },
});

/**
 * Request schemas for validation
 */
const parseRequestSchema = {
  type: 'object',
  required: ['text'],
  properties: {
    text: { type: 'string', minLength: 1 },
    tz: { type: 'string', default: 'UTC' },
    now: { type: 'string', pattern: ISO_INSTANT_PATTERN },
    features: {
      type: 'object',
      properties: {
        deterministicPreflight: { type: 'boolean' },
        ordinalWeekdayGrammar: { type: 'boolean' },
        semanticConsistencyGate: { type: 'boolean' }
      }
    }
  }
} as const;

const parseResponseSchema = {
  type: 'object',
  required: ['generationId', 'epoch', 'suggestedFormatIndex', 'confidence', 'method'],
  properties: {
    generationId: { type: 'string' },
    kind: { type: 'string', enum: ['instant', 'time_range'] },
    epoch: { type: 'number' },
    suggestedFormatIndex: { type: 'number' },
    range: {
      type: 'object',
      required: ['start', 'end', 'discord'],
      properties: {
        start: {
          type: 'object',
          required: ['epoch', 'suggestedFormatIndex', 'canonical'],
          properties: {
            epoch: { type: 'number' },
            suggestedFormatIndex: { type: 'number' },
            canonical: {
              type: 'object',
              properties: {
                isoInstant: { type: 'string' },
                zonedDateTime: { type: 'string' },
                timeZone: { type: 'string' },
                precision: { type: 'string' },
                weekday: { type: 'string' },
              }
            }
          }
        },
        end: {
          type: 'object',
          required: ['epoch', 'suggestedFormatIndex', 'canonical'],
          properties: {
            epoch: { type: 'number' },
            suggestedFormatIndex: { type: 'number' },
            canonical: {
              type: 'object',
              properties: {
                isoInstant: { type: 'string' },
                zonedDateTime: { type: 'string' },
                timeZone: { type: 'string' },
                precision: { type: 'string' },
                weekday: { type: 'string' },
              }
            }
          }
        },
        discord: { type: 'string' }
      }
    },
    confidence: { type: 'number' },
    method: { type: 'string' },
    canonical: {
      type: 'object',
      properties: {
        isoInstant: { type: 'string' },
        zonedDateTime: { type: 'string' },
        timeZone: { type: 'string' },
        precision: { type: 'string' },
        weekday: { type: 'string' },
      }
    }
  }
} as const;

const errorResponseSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    message: { type: 'string' },
    generationId: { type: 'string' },
    alternatives: {
      type: 'array',
      items: {
        type: 'object',
        required: ['label', 'epoch', 'suggestedFormatIndex', 'confidence', 'method'],
        properties: {
          label: { type: 'string' },
          kind: { type: 'string', enum: ['instant', 'time_range'] },
          epoch: { type: 'number' },
          suggestedFormatIndex: { type: 'number' },
          range: parseResponseSchema.properties.range,
          confidence: { type: 'number' },
          method: { type: 'string' }
        }
      }
    }
  },
  required: ['error']
};

const parseOutcomeRequestSchema = {
  type: 'object',
  required: ['generationId', 'action'],
  properties: {
    generationId: { type: 'string', minLength: 1 },
    action: {
      type: 'string',
      enum: ['copied', 'inserted', 'dismissed', 'edited_before_copy', 'timeout', 'feedback_submitted']
    },
    selectedFormatIndex: { type: 'number', minimum: 0, maximum: 6 },
    feedbackCategory: {
      type: 'string',
      enum: ['wrong_date', 'wrong_time', 'should_have_clarified', 'should_have_parsed', 'other']
    }
  }
} as const;

const parseOutcomeResponseSchema = {
  type: 'object',
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' }
  }
} as const;

const parseVerificationRequestSchema = {
  type: 'object',
  required: ['text', 'generationId', 'epoch', 'suggestedFormatIndex', 'confidence', 'method'],
  properties: {
    text: { type: 'string', minLength: 1 },
    tz: { type: 'string', default: 'UTC' },
    now: { type: 'string', pattern: ISO_INSTANT_PATTERN },
    generationId: { type: 'string', minLength: 1 },
    epoch: { type: 'number' },
    suggestedFormatIndex: { type: 'number', minimum: 0, maximum: 6 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    method: { type: 'string' },
    canonical: {
      type: 'object',
      properties: {
        isoInstant: { type: 'string' },
        zonedDateTime: { type: 'string' },
        timeZone: { type: 'string' },
        precision: { type: 'string' },
        weekday: { type: 'string' },
      }
    }
  }
} as const;

const parseVerificationResponseSchema = {
  type: 'object',
  required: ['generationId', 'decision', 'confidence', 'reasonCodes', 'explanation'],
  properties: {
    generationId: { type: 'string' },
    decision: { type: 'string', enum: ['accept', 'reject', 'uncertain'] },
    confidence: { type: 'number' },
    reasonCodes: { type: 'array', items: { type: 'string' } },
    explanation: { type: 'string' }
  }
} as const;

/**
 * Auth middleware
 */
server.addHook('preHandler', async (request, reply) => {
  // Skip auth for health check
  if (request.url === '/health') {
    return;
  }

  // Check API key
  const apiKey = request.headers[REQUIRED_HEADERS.API_KEY];
  if (!apiKey || apiKey !== config.staticApiKey) {
    const error: ErrorResponse = {
      error: 'unauthorized',
      message: 'Invalid or missing API key'
    };
    reply.status(401).send(error);
    return;
  }

  // Check API version
  const apiVersion = request.headers[REQUIRED_HEADERS.API_VERSION];
  if (!apiVersion || apiVersion !== API_VERSION) {
    const error: ErrorResponse = {
      error: 'bad_request',
      message: `API version ${API_VERSION} required`
    };
    reply.status(400).send(error);
    return;
  }
});

/**
 * Health check endpoint
 */
server.get('/health', async (_request, reply) => {
  const dbInfo = db.getInfo();
  const usageStats = db.getUsageStats();
  
  reply.send({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: API_VERSION,
    runtime: apiRuntime,
    database: {
      connected: true,
      size: dbInfo.size,
      tables: dbInfo.tables,
      totalRequests: usageStats.total,
      last24h: usageStats.last24h
    },
    config: config.getSanitizedConfig()
  });
});

/**
 * Parse endpoint with OpenAI + chrono-node fallback
 */
server.post<{ Body: ParseRequest }>('/parse', {
  schema: {
    body: parseRequestSchema,
    response: {
      200: parseResponseSchema,
      400: errorResponseSchema,
      500: errorResponseSchema
    }
  }
}, async (request, reply) => {
  const { text, tz = 'UTC', now } = request.body;

  try {
    if (now !== undefined && !isValidIsoInstant(now)) {
      return reply.status(400).send({
        error: 'bad_request',
        message: 'now must be a valid ISO instant like 2026-05-24T12:00:00Z'
      });
    }

    const parseInput: Parameters<typeof parseTemporalExpression>[0] = {
      text,
      timeZone: tz,
      features: {
        ...config.temporalFeatures,
        ...(request.body.features?.deterministicPreflight === undefined ? {} : { deterministicPreflight: request.body.features.deterministicPreflight }),
        ...(request.body.features?.ordinalWeekdayGrammar === undefined ? {} : { ordinalWeekdayGrammar: request.body.features.ordinalWeekdayGrammar }),
        ...(request.body.features?.semanticConsistencyGate === undefined ? {} : { semanticConsistencyGate: request.body.features.semanticConsistencyGate }),
      },
    };
    const planIrEndpoint = config.temporalPlanIrEndpoint;
    if (planIrEndpoint !== undefined) {
      parseInput.planIrEndpoint = planIrEndpoint;
    }
    if (now !== undefined) {
      parseInput.referenceInstant = now;
    }
    if (config.openaiApiKey !== undefined) {
      parseInput.openaiApiKey = config.openaiApiKey;
      parseInput.openaiModel = config.openaiModel;
      parseInput.openaiReasoningEffort = config.openaiReasoningEffort;
      parseInput.langfuse = {
        enabled: config.langfuseEnabled,
      };
      if (config.langfuseBaseUrl !== undefined) {
        parseInput.langfuse.baseUrl = config.langfuseBaseUrl;
      }
    }

    const parsed = await parseTemporalExpression(parseInput);
    logTemporalGeneration(text, tz, now, parsed);
    request.log.info({
      text,
      tz,
      status: parsed.status,
      generationId: parsed.generationId,
      method: parsed.method,
      epoch: parsed.epoch,
      confidence: parsed.confidence,
      debug: parsed.debug,
      validation: parsed.validation,
      ambiguity: parsed.ambiguity,
      clarificationQuestion: parsed.clarificationQuestion,
    }, 'parse result');

    // If all parsing failed
    if (parsed.status === 'failed' || parsed.epoch === undefined) {
      return reply.status(400).send({
        error: parsed.status === 'needs_clarification' ? 'needs_clarification' : 'Could not parse time expression',
        message: userFacingParseErrorMessage(parsed, text),
        generationId: parsed.generationId,
        alternatives: parsed.clarificationAlternatives?.map((alternative) => ({
          label: alternative.label,
          kind: alternative.kind,
          epoch: alternative.epoch,
          suggestedFormatIndex: alternative.suggestedFormatIndex,
          range: alternative.range,
          confidence: alternative.confidence,
          method: alternative.method,
        }))
      });
    }

    // Log successful parse
    db.logUsage({
      text,
      tz,
      epoch: parsed.epoch,
      format: parsed.suggestedFormatIndex ?? 4,
      conf: parsed.confidence,
      ip: request.ip
    });

    return {
      generationId: parsed.generationId ?? '',
      kind: parsed.kind ?? 'instant',
      epoch: parsed.epoch,
      suggestedFormatIndex: parsed.suggestedFormatIndex ?? 4,
      range: parsed.range,
      confidence: parsed.confidence,
      method: parsed.method,
      canonical: parsed.canonical,
    };

  } catch (error) {
    console.error('Parse endpoint error:', error);
    return reply.status(500).send({
      error: 'Internal server error',
      message: 'An unexpected error occurred while parsing the time expression'
    });
  }
});

server.post<{ Body: ParseVerificationRequest }>('/parse/verify', {
  schema: {
    body: parseVerificationRequestSchema,
    response: {
      200: parseVerificationResponseSchema,
      400: errorResponseSchema,
      500: errorResponseSchema,
    }
  }
}, async (request, reply) => {
  const { text, tz = 'UTC', now } = request.body;
  try {
    if (now !== undefined && !isValidIsoInstant(now)) {
      return reply.status(400).send({
        error: 'bad_request',
        message: 'now must be a valid ISO instant like 2026-05-24T12:00:00Z',
        generationId: request.body.generationId,
      });
    }

    const gate = await verifyTemporalParseResponseWithSemanticConsistencyGate(
      {
        text,
        calendarContext: parseCalendarContext(tz, now),
      },
      temporalResponseFromVerificationRequest(request.body, tz),
      {
        implementations: createDeterministicTemporalToolImplementations(),
        ...(config.openaiApiKey === undefined ? {} : {
          openaiApiKey: config.openaiApiKey,
          openaiModel: config.openaiModel,
          openaiReasoningEffort: config.openaiReasoningEffort,
          langfuse: { enabled: config.langfuseEnabled, ...(config.langfuseBaseUrl === undefined ? {} : { baseUrl: config.langfuseBaseUrl }) },
        }),
      },
    );

    return {
      generationId: request.body.generationId,
      decision: gate.decision,
      confidence: gate.confidence,
      reasonCodes: gate.reasonCodes,
      explanation: gate.explanation,
    };
  } catch (error) {
    request.log.error({ err: error, generationId: request.body.generationId }, 'parse verification failed');
    return reply.status(500).send({
      error: 'verification_failed',
      message: 'Could not verify the displayed timestamp.',
      generationId: request.body.generationId,
    });
  }
});

server.post<{ Body: ParseOutcomeRequest }>('/parse/outcome', {
  schema: {
    body: parseOutcomeRequestSchema,
    response: {
      200: parseOutcomeResponseSchema,
      400: errorResponseSchema,
    }
  }
}, async (request) => {
  db.logGenerationOutcome({
    generationId: request.body.generationId,
    action: request.body.action,
    ...(request.body.selectedFormatIndex === undefined ? {} : { selectedFormatIndex: request.body.selectedFormatIndex }),
    ...(request.body.feedbackCategory === undefined ? {} : { feedbackCategory: request.body.feedbackCategory }),
  });
  return { ok: true };
});

function isValidIsoInstant(value: string): boolean {
  if (!isoInstantPattern.test(value)) {
    return false;
  }

  try {
    Temporal.Instant.from(value);
    return true;
  } catch {
    return false;
  }
}

function userFacingParseErrorMessage(parsed: Awaited<ReturnType<typeof parseTemporalExpression>>, text: string): string {
  if (parsed.clarificationQuestion) {
    return parsed.clarificationQuestion;
  }

  const internalMessage = parsed.ambiguity[0] ?? parsed.validation.warnings[0] ?? '';
  if (parsed.status === 'needs_clarification') {
    if (/am\/pm|meridiem|bare time-like|compact time|bare number/i.test(internalMessage)) {
      return 'Please include AM or PM, or use 24-hour time like 16:30.';
    }
    return 'I need one more detail before making that timestamp.';
  }

  return genericParseFailureMessage(text, internalMessage);
}

function genericParseFailureMessage(text: string, internalMessage: string): string {
  if (/am\/pm|meridiem|bare time-like|compact time|bare number|bare 1-12 clock|unresolved time signal/i.test(`${text} ${internalMessage}`)) {
    return 'I could not confidently turn that into a timestamp. Check the date and include AM or PM if needed.';
  }

  return 'I could not confidently turn that into a timestamp. Check the date, time, and spelling, then try again.';
}

function temporalResponseFromVerificationRequest(body: ParseVerificationRequest, fallbackTimeZone: string): TemporalParseResponse {
  const response: TemporalParseResponse = {
    generationId: body.generationId,
    status: 'resolved',
    epoch: body.epoch,
    suggestedFormatIndex: body.suggestedFormatIndex,
    confidence: body.confidence,
    method: body.method as TemporalParseResponse['method'],
    canonical: canonicalFromVerificationRequest(body, fallbackTimeZone),
    assumptions: ['Post-display verification of the displayed parser candidate.'],
    ambiguity: [],
    validation: {
      passed: true,
      warnings: [],
      checks: ['post_display_candidate'],
    },
    debug: {
      candidateCount: 1,
      model: body.method,
    },
  };
  return response;
}

function canonicalFromVerificationRequest(body: ParseVerificationRequest, fallbackTimeZone: string): NonNullable<TemporalParseResponse['canonical']> {
  if (body.canonical !== undefined) {
    const canonical: NonNullable<TemporalParseResponse['canonical']> = {
      isoInstant: body.canonical.isoInstant,
      zonedDateTime: body.canonical.zonedDateTime,
      timeZone: body.canonical.timeZone,
      precision: body.canonical.precision as Candidate['precision'],
    };
    if (body.canonical.weekday !== undefined) {
      canonical.weekday = body.canonical.weekday as Weekday;
    }
    return canonical;
  }

  const instant = Temporal.Instant.fromEpochMilliseconds(body.epoch * 1000);
  const zoned = instant.toZonedDateTimeISO(fallbackTimeZone);
  const canonical: NonNullable<TemporalParseResponse['canonical']> = {
    isoInstant: instant.toString(),
    zonedDateTime: zoned.toString(),
    timeZone: fallbackTimeZone,
    precision: precisionFromSuggestedFormatIndex(body.suggestedFormatIndex),
  };
  return canonical;
}

function precisionFromSuggestedFormatIndex(index: number): Candidate['precision'] {
  if (index === 0 || index === 1) {
    return 'date';
  }
  if (index === 2 || index === 3) {
    return 'time';
  }
  if (index === 6) {
    return 'relative';
  }
  return 'datetime';
}

function logTemporalGeneration(text: string, timeZone: string, referenceInstant: string | undefined, parsed: TemporalParseResponse): void {
  if (parsed.generationId === undefined) {
    return;
  }

  const errorClass = generationErrorClass(parsed);

  db.logGeneration({
    generationId: parsed.generationId,
    surface: 'api',
    flowVersion: 'temporal-cascade-v1',
    requestTimeZone: timeZone,
    referenceInstant: referenceInstant ?? new Date().toISOString(),
    inputTextHash: hashInputText(text),
    inputTextRetained: false,
    finalStatus: parsed.status,
    finalMethod: parsed.method,
    ...(parsed.epoch === undefined ? {} : { finalEpoch: parsed.epoch }),
    ...(parsed.debug?.candidateCount === undefined ? {} : { candidateCount: parsed.debug.candidateCount }),
    clarificationAlternativeCount: parsed.clarificationAlternatives?.length ?? 0,
    ...(parsed.debug?.totalDurationMs === undefined ? {} : { totalDurationMs: parsed.debug.totalDurationMs }),
    ...(errorClass === undefined ? {} : { errorClass }),
  });
}

function hashInputText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function fileMtimeIso(filePath: string | undefined): string | undefined {
  if (filePath === undefined || filePath.trim() === '') {
    return undefined;
  }
  try {
    return statSync(filePath).mtime.toISOString();
  } catch {
    return undefined;
  }
}

function inferRuntimeMode(entrypoint: string | undefined): 'source' | 'dist' | 'unknown' {
  if (entrypoint === undefined) {
    return 'unknown';
  }
  const normalized = entrypoint.replace(/\\/g, '/');
  if (normalized.includes('/src/')) {
    return 'source';
  }
  if (normalized.includes('/dist/')) {
    return 'dist';
  }
  return 'unknown';
}

function generationErrorClass(parsed: TemporalParseResponse): string | undefined {
  if (parsed.status === 'resolved') {
    return undefined;
  }
  const message = parsed.ambiguity[0] ?? parsed.validation.warnings[0] ?? '';
  if (/Semantic Consistency Gate/i.test(message)) {
    return 'semantic_consistency_gate';
  }
  if (/No deterministic parse candidate/i.test(message)) {
    return 'no_deterministic_candidate';
  }
  if (/validation rejected/i.test(message)) {
    return 'validation_rejected';
  }
  if (parsed.status === 'needs_clarification') {
    return 'needs_clarification';
  }
  return 'parse_failed';
}

/**
 * Stats endpoint for monitoring
 */
server.get('/stats', async (_request, reply) => {
  const stats = db.getUsageStats();
  const recentUsage = db.getRecentUsage(5);
  
  reply.send({
    usage: stats,
    recent: recentUsage.map(record => ({
      text: record.text,
      tz: record.tz,
      format: record.format,
      confidence: record.conf,
      timestamp: record.ts
    }))
  });
});

/**
 * Error handler
 */
server.setErrorHandler(async (error, _request, reply) => {
  server.log.error({ err: error }, 'Unhandled error');
  const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error
    ? Number((error as { statusCode?: unknown }).statusCode)
    : undefined;
  const message = error instanceof Error ? error.message : 'Invalid request';
  
  // Rate limit errors
  if (statusCode === 429) {
    const errorResponse: ErrorResponse = {
      error: 'rate_limited',
      message: 'Too many requests'
    };
    reply.status(429).send(errorResponse);
    return;
  }
  
  // Validation errors
  if (statusCode === 400) {
    const errorResponse: ErrorResponse = {
      error: 'bad_request',
      message
    };
    reply.status(400).send(errorResponse);
    return;
  }
  
  // Generic error
  const errorResponse: ErrorResponse = {
    error: 'server_error',
    message: 'Internal server error'
  };
  reply.status(500).send(errorResponse);
});

/**
 * Graceful shutdown
 */
const gracefulShutdown = async (signal: string) => {
  console.log(`\nReceived ${signal}, shutting down gracefully...`);
  
  try {
    // Close database
    db.close();
    
    // Close server
    await server.close();
    
    console.log('Server shutdown complete');
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
};

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

/**
 * Start server
 */
const start = async () => {
  try {
    console.log('Starting Time-Parse API server...');
    console.log('Configuration:', config.getSanitizedConfig());
    
    // Initialize database with config path
    getDatabase(config.dbPath);
    
    await server.listen({
      host: '0.0.0.0',
      port: config.port
    });
    
    console.log(`Server listening on port ${config.port}`);
    console.log(`Health check available at: http://localhost:${config.port}/health`);
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

// Start the server
start(); 
