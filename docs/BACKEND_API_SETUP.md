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
- `OPENAI_API_KEY`: Your OpenAI API key
- `STATIC_API_KEY`: A secure API key for frontend authentication

### 2. Install Dependencies & Run

```bash
cd api
npm install
npm run dev
```

The API will start on http://localhost:8080 (default port)

### 3. Frontend Configuration

In the root directory, update `.env`:

```env
VITE_API_BASE_URL=http://localhost:8080
VITE_API_KEY=<same as STATIC_API_KEY from backend>
```

### 4. Run the Frontend

```bash
npm run start
```

## How It Works

1. **Frontend** sends time parsing requests to the backend API
2. **Backend** securely handles OpenAI API calls
3. **Response** includes parsed epoch, format suggestion, and confidence
4. **Security** - OpenAI API key never exposed to client

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

- Ensure backend is running before starting frontend
- Check API key matches in both `.env` files
- Verify CORS is properly configured for your domain