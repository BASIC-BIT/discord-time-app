#!/bin/bash

# Simple API test script
# Tests the HammerTime API endpoints

BASE_URL="http://localhost:8857"
API_KEY="STATIC_KEY_123"

echo "🧪 Testing HammerTime API"
echo "========================="

# Test health endpoint
echo "1. Testing health endpoint..."
curl -s "$BASE_URL/health" | jq . || echo "❌ Health check failed"
echo ""

# Test parse endpoint
echo "2. Testing parse endpoint..."
curl -s -X POST "$BASE_URL/parse" \
  -H "X-API-Key: $API_KEY" \
  -H "X-API-Version: 1" \
  -H "Content-Type: application/json" \
  -d '{"text": "tomorrow at 2pm", "tz": "America/New_York"}' | jq . || echo "❌ Parse test failed"
echo ""

# Test stats endpoint
echo "3. Testing stats endpoint..."
curl -s "$BASE_URL/stats" \
  -H "X-API-Key: $API_KEY" \
  -H "X-API-Version: 1" | jq . || echo "❌ Stats test failed"
echo ""

# Test error handling
echo "4. Testing error handling (invalid API key)..."
curl -s "$BASE_URL/parse" \
  -H "X-API-Key: wrong-key" \
  -H "X-API-Version: 1" \
  -H "Content-Type: application/json" \
  -d '{"text": "test", "tz": "UTC"}' | jq . || echo "❌ Error handling test failed"
echo ""

echo "✅ API tests complete!"
echo ""
echo "💡 Tip: Make sure the API server is running with 'npm run dev' or 'npm start'" 