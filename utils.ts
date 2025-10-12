import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const SALT = 'humanmode-autoposter';
const COOKIE_EXTENSION = '.json.enc';
let cachedKey: Buffer | null = null;

type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

export function ensureEnv(keys: string[]) {
  const missing = keys.filter((key) => !process.env[key] || String(process.env[key]).trim() === '');
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

export function cookieFilename(platform: string, userId: string | number, nickname: string) {
  return `${platform}_${userId}_${nickname}${COOKIE_EXTENSION}`;
}

export function cookieFilePath(platform: string, userId: string | number, nickname: string) {
  return path.join('sessions', cookieFilename(platform, userId, nickname));
}

export function writeEncryptedJson(filePath: string, payload: unknown) {
  const data = Buffer.from(JSON.stringify(payload, null, 2));
  const encrypted = encryptBuffer(data);
  fs.writeFileSync(filePath, encrypted);
}

export function readEncryptedJson<T = unknown>(filePath: string): T {
  const decrypted = decryptBuffer(fs.readFileSync(filePath));
  return JSON.parse(decrypted.toString('utf-8')) as T;
}

export function retry<T>(fn: () => Promise<T>, attempts = 3, baseDelayMs = 500): Promise<T> {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const execute = async () => {
      try {
        const value = await fn();
        resolve(value);
      } catch (err) {
        attempt += 1;
        if (attempt >= attempts) {
          reject(err);
        } else {
          const delay = baseDelayMs * Math.pow(2, attempt - 1);
          setTimeout(execute, delay);
        }
      }
    };
    execute();
  });
}

export function createLogger(context: string) {
  return {
    info: (message: string, meta?: Record<string, unknown>) => log('INFO', context, message, meta),
    warn: (message: string, meta?: Record<string, unknown>) => log('WARN', context, message, meta),
    error: (message: string, meta?: Record<string, unknown>) => log('ERROR', context, message, meta),
    debug: (message: string, meta?: Record<string, unknown>) => log('DEBUG', context, message, meta)
  };
}

function log(level: LogLevel, context: string, message: string, meta?: Record<string, unknown>) {
  const timestamp = new Date().toISOString();
  const payload = meta ? ` ${JSON.stringify(meta)}` : '';
  console.log(`[${timestamp}] [${context}] ${level} ${message}${payload}`);
}

function encryptBuffer(plain: Buffer) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]);
}

function decryptBuffer(payload: Buffer) {
  const key = getKey();
  const iv = payload.subarray(0, 12);
  const authTag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function getKey() {
  if (cachedKey) return cachedKey;
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret || secret.trim().length < 16) {
    throw new Error('ENCRYPTION_KEY must be set and at least 16 characters long.');
  }
  cachedKey = crypto.scryptSync(secret, SALT, 32);
  return cachedKey;
}
