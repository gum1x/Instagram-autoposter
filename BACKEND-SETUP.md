# Instagram Autoposter Bot - Local Backend Setup

This setup allows you to run your Instagram autoposter bot locally on your computer as a backend service using PM2 process manager.

## 🚀 Quick Start

1. **Make sure your `.env` file is configured** with:
   ```
   TELEGRAM_BOT_TOKEN=your_bot_token
   SUPABASE_URL=your_supabase_url
   SUPABASE_KEY=your_supabase_key
   ENCRYPTION_KEY=your_encryption_key
   ```

2. **Start the backend:**
   ```bash
   ./start-backend.sh
   ```

3. **Your bot is now running!** 🎉

## 📋 Management Commands

### Using the management script:
```bash
./manage.sh start      # Start all services
./manage.sh stop       # Stop all services
./manage.sh restart    # Restart all services
./manage.sh status     # Show service status
./manage.sh logs       # View logs
./manage.sh monitor    # Open PM2 monitor
```

### Using npm scripts:
```bash
npm run backend:start    # Start backend
npm run backend:stop     # Stop backend
npm run backend:restart  # Restart backend
npm run pm2:status       # Show PM2 status
npm run pm2:logs         # View PM2 logs
npm run pm2:monit        # Open PM2 monitor
```

### Direct PM2 commands:
```bash
npx pm2 start ecosystem.config.js  # Start services
npx pm2 stop all                   # Stop all services
npx pm2 restart all               # Restart all services
npx pm2 status                    # Show status
npx pm2 logs                      # View logs
npx pm2 monit                     # Open monitor
```

## 📁 Directory Structure

```
Instagram-autoposter/
├── dist/                    # Compiled JavaScript files
├── logs/                    # PM2 log files
├── uploads/                 # Uploaded media files
├── sessions/                # User session data
├── ecosystem.config.js      # PM2 configuration
├── start-backend.sh         # Startup script
├── stop-backend.sh          # Stop script
├── manage.sh               # Management script
└── .env                    # Environment variables
```

## 🔧 Services Running

1. **instagram-bot** - Main Telegram bot service
2. **instagram-scheduler** - Post scheduling service

Both services run automatically and restart if they crash.

## 📊 Monitoring

- **PM2 Monitor**: `npx pm2 monit` - Real-time monitoring dashboard
- **Logs**: `npx pm2 logs` - View all service logs
- **Status**: `npx pm2 status` - Check service health

## 🛠️ Troubleshooting

### Check if services are running:
```bash
npx pm2 status
```

### View error logs:
```bash
npx pm2 logs --err
```

### Restart a specific service:
```bash
npx pm2 restart instagram-bot
npx pm2 restart instagram-scheduler
```

### Clear logs:
```bash
npx pm2 flush
```

## 🔄 Auto-start on Boot (Optional)

To make the bot start automatically when your computer boots:

```bash
npx pm2 startup
npx pm2 save
```

This will create a startup script that runs PM2 when your system boots.

##  Testing

Once running, test your bot by:
1. Finding your bot on Telegram
2. Sending `/start` command
3. Uploading media and scheduling posts

Your bot is now running as a local backend service! 
