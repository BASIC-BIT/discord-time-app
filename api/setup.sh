#!/bin/bash

# HammerTime API Server Setup Script
# This script helps set up the API server quickly

set -e

echo "🔨 HammerTime API Server Setup"
echo "================================"

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 20.14+ LTS first."
    echo "   Visit: https://nodejs.org/"
    exit 1
fi

# Check Node.js version
NODE_VERSION=$(node --version | cut -d'v' -f2)
REQUIRED_VERSION="20.14.0"
if [[ "$(printf '%s\n' "$REQUIRED_VERSION" "$NODE_VERSION" | sort -V | head -n1)" != "$REQUIRED_VERSION" ]]; then
    echo "❌ Node.js version $NODE_VERSION is too old. Please install Node.js $REQUIRED_VERSION or newer."
    exit 1
fi

echo "✅ Node.js version: $NODE_VERSION"

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Create environment file if it doesn't exist
if [ ! -f ".env" ]; then
    echo "🔧 Creating environment file..."
    cp env.example .env
    echo "📝 Please edit .env file with your actual values:"
    echo "   - OPENAI_API_KEY: Your OpenAI API key"
    echo "   - STATIC_API_KEY: Your API authentication key"
    echo ""
    echo "   Example:"
    echo "   nano .env"
    echo ""
else
    echo "✅ Environment file already exists"
fi

# Build the project
echo "🏗️  Building TypeScript..."
npm run build

echo ""
echo "✅ Setup complete!"
echo ""
echo "🚀 Next steps:"
echo "   1. Edit .env file with your API keys"
echo "   2. Run in development mode: npm run dev"
echo "   3. Or run in production mode: npm start"
echo ""
echo "🏥 Health check: http://localhost:8080/health"
echo "📊 API endpoint: http://localhost:8080/parse"
echo ""
echo "📚 For more information, see README.md" 