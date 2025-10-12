#!/bin/bash

# Instagram Autoposter Bot - Management Script
case "$1" in
    start)
        echo "🚀 Starting Instagram Autoposter Bot..."
        ./start-backend.sh
        ;;
    stop)
        echo "🛑 Stopping Instagram Autoposter Bot..."
        ./stop-backend.sh
        ;;
    restart)
        echo "🔄 Restarting Instagram Autoposter Bot..."
        ./stop-backend.sh
        sleep 2
        ./start-backend.sh
        ;;
    status)
        echo "📊 Service Status:"
        npx pm2 status
        ;;
    logs)
        echo "📋 Viewing logs..."
        npx pm2 logs
        ;;
    monitor)
        echo "📊 Opening PM2 monitor..."
        npx pm2 monit
        ;;
    *)
        echo "Instagram Autoposter Bot Management Script"
        echo ""
        echo "Usage: $0 {start|stop|restart|status|logs|monitor}"
        echo ""
        echo "Commands:"
        echo "  start    - Start the bot and scheduler services"
        echo "  stop     - Stop all services"
        echo "  restart  - Restart all services"
        echo "  status   - Show service status"
        echo "  logs     - View service logs"
        echo "  monitor  - Open PM2 monitoring dashboard"
        echo ""
        exit 1
        ;;
esac
