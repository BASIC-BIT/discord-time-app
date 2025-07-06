# HammerTime API Server

A secure backend API server for parsing natural language time expressions into Discord timestamp formats using OpenAI GPT-4o-mini.

## Features

- 🧠 **OpenAI GPT-4o-mini** integration for intelligent time parsing
- 🔒 **API key authentication** with static keys
- 📊 **Usage logging** with SQLite database
- 🚦 **Rate limiting** (60 requests/minute per API key)
- 🏥 **Health checks** and monitoring endpoints
- 🐳 **Docker support** with multi-stage builds
- 📋 **Request validation** using JSON Schema
- 🔄 **Graceful shutdown** handling
- 📈 **Comprehensive logging** with structured output

## Quick Start

### Prerequisites

- Node.js 20.14+ LTS
- OpenAI API key (starts with `sk-`)
- npm or pnpm package manager

### Installation

1. **Clone and navigate to the API directory:**
   ```bash
   cd api
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Set up environment variables:**
   ```bash
   cp env.example .env
   # Edit .env with your actual values
   ```

4. **Run in development mode:**
   ```bash
   npm run dev
   ```

5. **Build for production:**
   ```bash
   npm run build
   npm start
   ```

## Environment Variables

Create a `.env` file in the API directory:

```env
# OpenAI API Key for time parsing (required)
OPENAI_API_KEY=sk-your-openai-api-key-here

# API authentication key (must match client header)
STATIC_API_KEY=STATIC_KEY_123

# Server port (optional, defaults to 8080)
PORT=8080

# Database path (optional, defaults to usage.db)
DB_PATH=usage.db
```

## API Endpoints

### POST /parse

Convert natural language time expressions to Discord timestamps.

**Headers:**
- `X-API-Key: STATIC_KEY_123` (required)
- `X-API-Version: 1` (required)
- `Content-Type: application/json`

**Request Body:**
```json
{
  "text": "tomorrow at 2pm",
  "tz": "America/New_York"
}
```

**Response (200 OK):**
```json
{
  "epoch": 1752345600,
  "suggestedFormatIndex": 4,
  "confidence": 0.95
}
```

**Discord Format Indices:**
- `0`: `:d` - Short Date (07/05/2025)
- `1`: `:D` - Long Date (July 5, 2025)
- `2`: `:t` - Short Time (9:30 AM)
- `3`: `:T` - Long Time (9:30:00 AM)
- `4`: `:f` - Short Date/Time (July 5, 2025 9:30 AM)
- `5`: `:F` - Long Date/Time (Saturday, July 5, 2025 9:30 AM)
- `6`: `:R` - Relative Time (in 2 hours)

### GET /health

Health check endpoint for monitoring.

**Response (200 OK):**
```json
{
  "status": "healthy",
  "timestamp": "2025-01-16T10:30:00.000Z",
  "version": "1",
  "database": {
    "connected": true,
    "size": 32768,
    "tables": ["usage"],
    "totalRequests": 1250,
    "last24h": 45
  },
  "config": {
    "OPENAI_API_KEY": "sk-proj...",
    "STATIC_API_KEY": "STATIC...",
    "PORT": 8080,
    "DB_PATH": "usage.db"
  }
}
```

### GET /stats

Usage statistics and recent activity (requires authentication).

**Response (200 OK):**
```json
{
  "usage": {
    "total": 1250,
    "byFormat": {
      "0": 150,
      "1": 200,
      "4": 500,
      "6": 400
    },
    "last24h": 45
  },
  "recent": [
    {
      "text": "tomorrow at 2pm",
      "tz": "America/New_York",
      "format": 4,
      "confidence": 0.95,
      "timestamp": "2025-01-16T10:25:00.000Z"
    }
  ]
}
```

## Error Responses

All errors follow a consistent format:

```json
{
  "error": "error_type",
  "message": "Human-readable error description"
}
```

**Error Types:**
- `400 bad_request` - Invalid request data
- `401 unauthorized` - Missing or invalid API key
- `429 rate_limited` - Too many requests
- `500 server_error` - Internal server error

## Docker Deployment

### Using Docker Compose (Recommended)

1. **Create environment file:**
   ```bash
   cp env.example .env
   # Edit .env with your values
   ```

2. **Start the services:**
   ```bash
   docker-compose up -d
   ```

3. **Check health:**
   ```bash
   curl http://localhost:8080/health
   ```

### Using Docker directly

1. **Build the image:**
   ```bash
   docker build -t hammertime-api .
   ```

2. **Run the container:**
   ```bash
   docker run -d \
     --name hammertime-api \
     -p 8080:8080 \
     -e OPENAI_API_KEY=sk-your-key \
     -e STATIC_API_KEY=STATIC_KEY_123 \
     -v $(pwd)/data:/app/data \
     hammertime-api
   ```

### Production Deployment with Nginx

For production deployment with SSL termination:

```bash
# Start with nginx reverse proxy
docker-compose --profile production up -d

# Add SSL certificates to ./ssl/ directory
# - cert.pem (SSL certificate)
# - key.pem (SSL private key)
```

## Usage Examples

### cURL Examples

```bash
# Parse a time expression
curl -X POST http://localhost:8080/parse \
  -H "X-API-Key: STATIC_KEY_123" \
  -H "X-API-Version: 1" \
  -H "Content-Type: application/json" \
  -d '{"text": "tomorrow at 2pm", "tz": "America/New_York"}'

# Health check
curl http://localhost:8080/health

# Get usage stats
curl http://localhost:8080/stats \
  -H "X-API-Key: STATIC_KEY_123" \
  -H "X-API-Version: 1"
```

### JavaScript/TypeScript Client

```typescript
interface ParseRequest {
  text: string;
  tz: string;
}

interface ParseResponse {
  epoch: number;
  suggestedFormatIndex: number;
  confidence: number;
}

async function parseTime(text: string, timezone: string): Promise<ParseResponse> {
  const response = await fetch('http://localhost:8080/parse', {
    method: 'POST',
    headers: {
      'X-API-Key': 'STATIC_KEY_123',
      'X-API-Version': '1',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ text, tz: timezone })
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  return response.json();
}

// Usage
const result = await parseTime('tomorrow at 2pm', 'America/New_York');
console.log(`Discord timestamp: <t:${result.epoch}:${formats[result.suggestedFormatIndex]}>`);
```

## Database Schema

The API uses SQLite for usage logging:

```sql
CREATE TABLE usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,           -- Input text
  tz TEXT NOT NULL,             -- Timezone
  epoch INTEGER NOT NULL,       -- Parsed timestamp
  format INTEGER NOT NULL,      -- Selected format index
  conf REAL NOT NULL,          -- Confidence score
  ip TEXT NOT NULL,            -- Client IP
  ts DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## Monitoring and Logging

### Health Monitoring

The `/health` endpoint provides comprehensive health information:
- Server status
- Database connectivity
- Usage statistics
- Configuration (sanitized)

### Logging

The API uses structured logging with different levels:
- **INFO**: Normal operations
- **WARN**: Recoverable errors
- **ERROR**: Serious errors

Logs are written to stdout and can be configured using environment variables.

### Performance Monitoring

Key metrics to monitor:
- Response times (target: <1s p99)
- Error rates
- Rate limit hits
- Database size growth

## Security Considerations

1. **API Key Management**: Store `STATIC_API_KEY` securely
2. **OpenAI Key Protection**: Never expose the OpenAI API key
3. **Rate Limiting**: Built-in protection against abuse
4. **Input Validation**: All inputs are validated and sanitized
5. **Error Handling**: Errors don't expose sensitive information

## Development

### Project Structure

```
api/
├── src/
│   ├── index.ts        # Main server
│   ├── types.ts        # TypeScript interfaces
│   ├── config.ts       # Environment configuration
│   ├── database.ts     # SQLite operations
│   └── openai.ts       # OpenAI integration
├── Dockerfile          # Docker configuration
├── docker-compose.yml  # Docker Compose setup
├── nginx.conf          # Nginx configuration
└── README.md          # This file
```

### Development Commands

```bash
# Install dependencies
npm install

# Start development server with hot reload
npm run dev

# Build TypeScript
npm run build

# Start production server
npm start

# Run with Docker
docker-compose up --build
```

### Environment Setup

For development, you can use a `.env` file:

```env
NODE_ENV=development
OPENAI_API_KEY=sk-your-dev-key
STATIC_API_KEY=dev-key-123
PORT=8080
DB_PATH=./dev-usage.db
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

MIT License - see the main project LICENSE file for details.

## Support

For issues and questions:
1. Check the health endpoint for server status
2. Review the logs for error details
3. Ensure environment variables are set correctly
4. Verify OpenAI API key is valid and has credits

## Changelog

### v1.0.0
- Initial release
- OpenAI GPT-4o-mini integration
- SQLite usage logging
- Rate limiting and authentication
- Docker support
- Health monitoring 