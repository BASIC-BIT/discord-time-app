import fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { ParseRequest, ParseResponse, ErrorResponse, API_VERSION, REQUIRED_HEADERS } from './types';
import { config } from './config';
import { db, getDatabase } from './database';
import { createOpenAIParser } from './openai';

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

const server = fastify({
  logger: createLoggerConfig(),
  trustProxy: true,
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
  properties: {
    text: { type: 'string', maxLength: 512 },
    tz: { type: 'string' }
  },
  required: ['text', 'tz'],
  additionalProperties: false
};

const parseResponseSchema = {
  type: 'object',
  properties: {
    epoch: { type: 'number' },
    suggestedFormatIndex: { type: 'number', minimum: 0, maximum: 6 },
    confidence: { type: 'number', minimum: 0, maximum: 1 }
  },
  required: ['epoch', 'suggestedFormatIndex', 'confidence']
};

const errorResponseSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    message: { type: 'string' }
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
 * Parse endpoint
 */
server.post<{
  Body: ParseRequest;
  Reply: ParseResponse | ErrorResponse;
}>('/parse', {
  schema: {
    body: parseRequestSchema,
    response: {
      200: parseResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      429: errorResponseSchema,
      500: errorResponseSchema
    }
  }
}, async (request, reply) => {
  const { text, tz } = request.body;
  const clientIP = request.ip;
  
  try {
    // Validate input
    if (!text.trim()) {
      const error: ErrorResponse = {
        error: 'bad_request',
        message: 'Text cannot be empty'
      };
      reply.status(400).send(error);
      return;
    }

    // Create OpenAI parser
    const parser = createOpenAIParser(config.openaiApiKey);
    
    // Parse using OpenAI
    const result = await parser.parseTime(text.trim(), tz);
    
    // Log usage to database
    db.logUsage({
      text: text.trim(),
      tz: tz,
      epoch: result.epoch,
      format: result.suggestedFormatIndex,
      conf: result.confidence,
      ip: clientIP
    });

    // Return response
    reply.send({
      epoch: result.epoch,
      suggestedFormatIndex: result.suggestedFormatIndex,
      confidence: result.confidence
    });

  } catch (error) {
    server.log.error('Parse error:', error);
    
    // Handle different error types
    if (error instanceof Error) {
      if (error.message.includes('API key')) {
        const errorResponse: ErrorResponse = {
          error: 'server_error',
          message: 'OpenAI API configuration error'
        };
        reply.status(500).send(errorResponse);
        return;
      }
      
      if (error.message.includes('rate limit')) {
        const errorResponse: ErrorResponse = {
          error: 'server_error',
          message: 'External API rate limit exceeded'
        };
        reply.status(500).send(errorResponse);
        return;
      }
    }
    
    // Generic server error
    const errorResponse: ErrorResponse = {
      error: 'server_error',
      message: 'Failed to parse time expression'
    };
    reply.status(500).send(errorResponse);
  }
});

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
  server.log.error('Unhandled error:', error);
  
  // Rate limit errors
  if (error.statusCode === 429) {
    const errorResponse: ErrorResponse = {
      error: 'rate_limited',
      message: 'Too many requests'
    };
    reply.status(429).send(errorResponse);
    return;
  }
  
  // Validation errors
  if (error.statusCode === 400) {
    const errorResponse: ErrorResponse = {
      error: 'bad_request',
      message: error.message || 'Invalid request'
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