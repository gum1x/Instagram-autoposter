#!/usr/bin/env node

// Scheduler worker for Render Background Worker
import { createLogger } from './utils.js';
import { createDatabase } from './database.js';
import { ensureEnv } from './utils.js';

const log = createLogger('scheduler-worker');
const db = createDatabase();

// Ensure required environment variables
ensureEnv(['TELEGRAM_BOT_TOKEN', 'ENCRYPTION_KEY']);

log.info('Scheduler worker started');

// Import and start the scheduler
import('./dist/scheduler.js').catch(error => {
  log.error('Failed to start scheduler:', error);
  process.exit(1);
});
