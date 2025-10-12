#!/bin/bash

# Instagram Autoposter Bot - Local Backend Startup Script
echo "🚀 Starting Instagram Autoposter Bot Backend..."

# Check if .env file exists
if [ ! -f .env ]; then
    echo "❌ .env file not found. Please create one with your environment variables."
    echo "Required variables:"
    echo "  - TELEGRAM_BOT_TOKEN"
    echo "  - SUPABASE_URL"
    echo "  - SUPABASE_KEY"
    echo "  - ENCRYPTION_KEY"
    exit 1
fi

# Load environment variables
source .env

# Check required environment variables
if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
    echo "❌ TELEGRAM_BOT_TOKEN not set in .env file"
    exit 1
fi

if [ -z "$SUPABASE_URL" ]; then
    echo "❌ SUPABASE_URL not set in .env file"
    exit 1
fi

if [ -z "$SUPABASE_KEY" ]; then
    echo "❌ SUPABASE_KEY not set in .env file"
    exit 1
fi

# Build the project
echo "🔨 Building project..."
npm run build

# Create necessary directories
echo "📁 Creating directories..."
mkdir -p uploads sessions logs

# Install dependencies if needed
echo "📦 Installing dependencies..."
npm install

# Start the services with PM2
echo "🚀 Starting services with PM2..."
npx pm2 start ecosystem.config.cjs

# Show status
echo "📊 Service Status:"
npx pm2 status

echo ""
echo "✅ Instagram Autoposter Bot is now running!"
echo ""
echo "📋 Useful commands:"
echo "  - View logs: npx pm2 logs"
echo "  - Stop services: npx pm2 stop all"
echo "  - Restart services: npx pm2 restart all"
echo "  - View status: npx pm2 status"
echo "  - Monitor: npx pm2 monit"
echo ""
echo "🌐 Your bot is ready to receive messages on Telegram!"
