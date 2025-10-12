#!/bin/bash

# Railway deployment script
echo "🚀 Deploying Instagram Autoposter Bot to Railway..."

# Check if Railway CLI is available
if ! command -v npx &> /dev/null; then
    echo "❌ npx not found. Please install Node.js first."
    exit 1
fi

# Login to Railway (this will open browser)
echo "📱 Please login to Railway in your browser..."
npx @railway/cli login

# Initialize project
echo "🔧 Initializing Railway project..."
npx @railway/cli init

# Set environment variables
echo "🔐 Setting environment variables..."
npx @railway/cli variables set TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN
npx @railway/cli variables set SUPABASE_URL=$SUPABASE_URL
npx @railway/cli variables set SUPABASE_KEY=$SUPABASE_KEY
npx @railway/cli variables set NODE_ENV=production

# Deploy
echo "🚀 Deploying to Railway..."
npx @railway/cli up

echo "✅ Deployment complete!"
echo "🌐 Your bot is now running on Railway!"

