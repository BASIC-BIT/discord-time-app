import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { ParseRequest, ErrorResponse, API_VERSION, REQUIRED_HEADERS } from './types';
import { config } from './config';
import { db, getDatabase } from './database';
import { createOpenAIParser } from './openai';
import { parseFallback } from './parse';

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
    tz: { type: 'string', default: 'UTC' }
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
  const { text, tz = 'UTC' } = request.body;

  try {
    let epoch: number | null = null;
    let suggestedFormatIndex = 4; // Default to :f format
    let confidence = 0.5;
    let method = 'fallback';

    // Try OpenAI parsing first (if API key available)
    if (config.openaiApiKey) {
      try {
        const openaiParser = createOpenAIParser(config.openaiApiKey);
        const llmResult = await openaiParser.parseTime(text, tz);
        
        console.log('LLM Result:', llmResult);
        
        // Use chrono-node to parse the normalized text
        const normalizedEpoch = parseFallback(llmResult.normalizedText);
        
        if (normalizedEpoch) {
          epoch = normalizedEpoch;
          suggestedFormatIndex = llmResult.suggestedFormatIndex;
          confidence = llmResult.confidence;
          method = 'openai';
        } else {
          // If normalized text fails, try original text as fallback
          const fallbackEpoch = parseFallback(text);
          if (fallbackEpoch) {
            epoch = fallbackEpoch;
            suggestedFormatIndex = llmResult.suggestedFormatIndex;
            confidence = llmResult.confidence * 0.7; // Reduce confidence
            method = 'openai-fallback';
          }
        }
      } catch (openaiError) {
        console.error('OpenAI parsing failed:', openaiError);
        // Fall through to chrono-node fallback
      }
    }

    // Fallback to chrono-node only if OpenAI failed
    if (epoch === null) {
      epoch = parseFallback(text);
      if (epoch) {
        confidence = 0.7; // Medium confidence for fallback
        method = 'fallback';
      }
    }

    // If all parsing failed
    if (epoch === null) {
      return reply.status(400).send({
        error: 'Could not parse time expression',
        message: 'Unable to understand the time expression. Please try being more specific.'
      });
    }

    // Log successful parse
    db.logUsage({
      text,
      tz,
      epoch,
      format: suggestedFormatIndex,
      conf: confidence,
      ip: request.ip
    });

    return {
      epoch,
      suggestedFormatIndex,
      confidence,
      method
    };

  } catch (error) {
    console.error('Parse endpoint error:', error);
    return reply.status(500).send({
      error: 'Internal server error',
      message: 'An unexpected error occurred while parsing the time expression'
    });
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