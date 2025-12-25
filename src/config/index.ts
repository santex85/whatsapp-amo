import dotenv from 'dotenv';

dotenv.config();

export const config = {
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
  },
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
  },
  database: {
    path: process.env.DB_PATH || './storage/database/sessions.db',
  },
  media: {
    storagePath: process.env.MEDIA_STORAGE_PATH || './storage/media',
    cleanupInterval: parseInt(process.env.MEDIA_CLEANUP_INTERVAL || '3600000', 10),
  },
  antiBan: {
    minDelayMs: parseInt(process.env.MIN_DELAY_MS || '2000', 10),
    maxDelayMs: parseInt(process.env.MAX_DELAY_MS || '10000', 10),
    typingDurationMs: parseInt(process.env.TYPING_DURATION_MS || '1500', 10),
  },
};

