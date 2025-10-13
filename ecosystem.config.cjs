module.exports = {
  apps: [
    {
      name: 'instagram-bot',
      script: 'dist/bot.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      restart_delay: 5000,
      env_file: '.env',
      env: {
        NODE_ENV: 'production',
        HEADLESS: 'true'
      },
      error_file: './logs/bot-error.log',
      out_file: './logs/bot-out.log',
      log_file: './logs/bot-combined.log',
      time: true
    },
    {
      name: 'instagram-scheduler',
      script: 'dist/scheduler.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env_file: '.env',
      env: {
        NODE_ENV: 'production'
      },
      error_file: './logs/scheduler-error.log',
      out_file: './logs/scheduler-out.log',
      log_file: './logs/scheduler-combined.log',
      time: true
    },
    {
      name: 'instagrapi-service',
      script: 'uvicorn',
      args: 'pyservice.main:app --host 127.0.0.1 --port 8081',
      cwd: './',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production'
      },
      error_file: './logs/pyservice-error.log',
      out_file: './logs/pyservice-out.log',
      log_file: './logs/pyservice-combined.log',
      time: true,
      interpreter: 'pyservice/.venv/bin/python'
    }
  ]
};
