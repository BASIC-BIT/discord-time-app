import 'dotenv/config'; // Load .env file
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { Temporal } from '@js-temporal/polyfill';
import { ParseRequest, ErrorResponse, API_VERSION, REQUIRED_HEADERS } from './types';
import { config } from './config';
import { db, getDatabase } from './database';
import { parseTemporalExpression } from './temporal';

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

const ISO_INSTANT_PATTERN = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,9})?)?(?:[zZ]|[+-]\\d{2}:\\d{2})$';
const isoInstantPattern = new RegExp(ISO_INSTANT_PATTERN);

/**
 * Register CORS plugin
 */
server.register(cors, {
  origin: ['http://localhost:1420', 'tauri://localhost', 'http://tauri.localhost'],
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
    now: { type: 'string', pattern: ISO_INSTANT_PATTERN }
  }
} as const;

const parseResponseSchema = {
  type: 'object',
  required: ['epoch', 'suggestedFormatIndex', 'confidence', 'method'],
  properties: {
    epoch: { type: 'number' },
    suggestedFormatIndex: { type: 'number' },
    confidence: { type: 'number' },
    method: { type: 'string' }
  }
} as const;

const errorResponseSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    message: { type: 'string' },
    alternatives: {
      type: 'array',
      items: {
        type: 'object',
        required: ['label', 'epoch', 'suggestedFormatIndex', 'confidence', 'method'],
        properties: {
          label: { type: 'string' },
          epoch: { type: 'number' },
          suggestedFormatIndex: { type: 'number' },
          confidence: { type: 'number' },
          method: { type: 'string' }
        }
      }
    }
  },
  required: ['error']
};

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
    };
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
    request.log.info({
      text,
      tz,
      status: parsed.status,
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
        message: userFacingParseErrorMessage(parsed),
        alternatives: parsed.clarificationAlternatives?.map((alternative) => ({
          label: alternative.label,
          epoch: alternative.epoch,
          suggestedFormatIndex: alternative.suggestedFormatIndex,
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
      epoch: parsed.epoch,
      suggestedFormatIndex: parsed.suggestedFormatIndex ?? 4,
      confidence: parsed.confidence,
      method: parsed.method
    };

  } catch (error) {
    console.error('Parse endpoint error:', error);
    return reply.status(500).send({
      error: 'Internal server error',
      message: 'An unexpected error occurred while parsing the time expression'
    });
  }
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

function userFacingParseErrorMessage(parsed: Awaited<ReturnType<typeof parseTemporalExpression>>): string {
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

  if (/^Final LLM validation rejected candidate:/i.test(internalMessage)) {
    return 'I could not confidently turn that into a timestamp. Try adding AM/PM, a date, or more context.';
  }

  if (/^Agent did not produce a validated final candidate\.?$/i.test(internalMessage)) {
    return 'I could not confidently turn that into a timestamp. Try adding AM/PM, a date, or more context.';
  }

  return internalMessage || 'Unable to understand the time expression. Please try being more specific.';
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
