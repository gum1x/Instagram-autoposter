#!/bin/bash

# Instagram Autoposter Bot - Stop Script
echo "🛑 Stopping Instagram Autoposter Bot Backend..."

# Stop all PM2 processes
npx pm2 stop all

# Show status
echo "📊 Service Status:"
npx pm2 status

echo "✅ All services stopped!"
