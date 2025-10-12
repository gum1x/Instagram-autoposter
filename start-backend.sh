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

# Check if using Supabase (optional)
if [ -n "$SUPABASE_URL" ] && [ -n "$SUPABASE_KEY" ]; then
    echo "✅ Using Supabase database"
elif [ -n "$DATABASE_URL" ]; then
    echo "✅ Using PostgreSQL database"
else
    echo "✅ Using SQLite database (local)"
fi

# Install dependencies first
echo "📦 Installing dependencies..."
npm install

# Build the project
echo "🔨 Building project..."
npm run build

# Create necessary directories
echo "📁 Creating directories..."
mkdir -p uploads sessions logs

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
