# Backend API Setup Guide

The backend API has been integrated to resolve the security issue of exposing OpenAI API keys in the frontend.

## Quick Start

### 1. Backend Setup

Navigate to the API directory and set up environment variables:

```bash
cd api
cp .env.example .env
```

Edit `.env` and configure:
- `OPENAI_API_KEY`: optional OpenAI API key for agent-assisted parsing
- `STATIC_API_KEY`: API key for frontend authentication, defaulting to `STATIC_KEY_123` for local QA
- `TEMPORAL_FEATURE_PLAN_IR`: optional experimental structured plan/action-list parser, defaulting to `false`

### 2. Install Dependencies & Run

```bash
cd api
npm install
npm run dev
```

The API will start on http://127.0.0.1:8857

### 3. Frontend Configuration

In Tauri desktop builds, HammerOverlay asks the Rust runtime for local parser service credentials, so a bundled `VITE_API_KEY` is not required. The Rust runtime generates a per-install local API key under the app data directory and passes it to the bundled sidecar API. For browser-only development or preview, update `.env` if you are not using the local defaults:

```env
VITE_API_BASE_URL=http://127.0.0.1:8857
VITE_API_KEY=STATIC_KEY_123
```

### 4. Run the Frontend

```bash
npm run start
```

The desktop build stages a bundled Node runtime, `api/dist`, and production API dependencies with `npm run prepare:api-sidecar`. At runtime, the app starts the bundled sidecar API when the local parser service is not already healthy. Set `HAMMEROVERLAY_API_ENTRYPOINT` or `HAMMEROVERLAY_NODE` to override the entrypoint or Node executable during development.

OpenAI and Langfuse secrets are not bundled. For local development, the launcher forwards values from `api/.env` when present. Installed builds need those values supplied through environment/config until a Settings UI for parser credentials exists.

## How It Works

1. **Frontend** sends time parsing requests to the backend API
2. **Desktop runtime** supplies per-install local API credentials when running inside Tauri
3. **Sidecar API** runs from bundled Node/runtime resources
4. **Backend** securely handles OpenAI API calls when configured
5. **Response** includes parsed epoch, format suggestion, and confidence
6. **Security** - OpenAI API key never exposed to client

## API Endpoints

- `POST /parse` - Parse natural language time expressions
  - Headers: `x-api-key`, `x-api-version: 1`
  - Body: `{ text: string, tz?: string }`
  - Response: `{ epoch: number, suggestedFormatIndex: number, confidence: number, method: string }`

- `GET /health` - Health check endpoint

## Production Deployment

For production, deploy the backend API separately:
- Use Docker: `docker-compose up -d`
- Update `VITE_API_BASE_URL` to production URL
- Use environment-specific API keys

## Troubleshooting

- For Tauri, check `time-parser-api.out.log` and `time-parser-api.err.log` under the app data directory
- For development overrides, check that `api/dist/index.js` exists and `node` is on PATH, or set `HAMMEROVERLAY_API_ENTRYPOINT` / `HAMMEROVERLAY_NODE`
- For browser-only development, ensure backend is running before starting frontend
- Check API key matches in both `.env` files when not using Tauri runtime credentials
- Verify CORS is properly configured for your domain
