'use strict';

/**
 * redis.client.js — FULLY FIXED (PRODUCTION SAFE)
 *
 * ✅ Safe disable mode (no null crash)
 * ✅ Health check support
 * ✅ Retry strategy with backoff
 * ✅ Controlled reconnect
 * ✅ Graceful shutdown
 */

const Redis = require('ioredis');

const logger = (() => {
  try {
    return require('./logger');
  } catch {
    return console;
  }
})();

// ─────────────────────────────────────────────
// ENABLE / DISABLE
// ─────────────────────────────────────────────

const ENABLED = process.env.CACHE_PROVIDER === 'redis';

if (!ENABLED) {
  logger.warn('[redis] disabled (CACHE_PROVIDER != redis)');

  // ✅ SAFE STUB OBJECT (NO CRASHES)
  const disabledRedis = {
    isReady: () => false,

    // No-op methods to prevent crashes
    set: async () => null,
    get: async () => null,
    del: async () => null,
    setex: async () => null,

    // Optional wrapper compatibility
    safeExec: async () => {
      throw new Error('REDIS_DISABLED');
    },
  };

  module.exports = disabledRedis;
  return;
}

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────

let redisConfig;

if (process.env.REDIS_URL) {
  redisConfig = process.env.REDIS_URL;
} else {
  redisConfig = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
  };
}

// ─────────────────────────────────────────────
// CLIENT INIT
// ─────────────────────────────────────────────

const redis = new Redis(redisConfig, {
  maxRetriesPerRequest: 2,
  enableReadyCheck: true,
  lazyConnect: false,

  // ✅ Controlled retry strategy
  retryStrategy(times) {
    const delay = Math.min(times * 100, 2000);
    logger.warn('[redis] retrying connection', { attempt: times, delay });
    return delay;
  },

  // ✅ Only reconnect on safe errors
  reconnectOnError(err) {
    if (err.message.includes('READONLY')) {
      logger.warn('[redis] reconnecting due to READONLY');
      return true;
    }
    return false;
  },
});

// ─────────────────────────────────────────────
// CONNECTION STATE
// ─────────────────────────────────────────────

let isConnected = false;

redis.on('connect', () => {
  logger.info('[redis] connected');
});

redis.on('ready', () => {
  isConnected = true;
  logger.info('[redis] ready');
});

redis.on('error', (err) => {
  isConnected = false;
  logger.error('[redis] error', { error: err.message });
});

redis.on('close', () => {
  isConnected = false;
  logger.warn('[redis] connection closed');
});

// ─────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────

redis.isReady = () => isConnected;

// ─────────────────────────────────────────────
// SAFE EXEC WRAPPER
// ─────────────────────────────────────────────

redis.safeExec = async (fn, timeoutMs = 5000) => {
  if (!redis.isReady()) {
    throw new Error('REDIS_NOT_READY');
  }

  return Promise.race([
    fn(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('REDIS_TIMEOUT')), timeoutMs)
    ),
  ]);
};

// ─────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────

async function shutdown() {
  try {
    logger.info('[redis] shutting down...');
    await redis.quit();
  } catch (err) {
    logger.error('[redis] shutdown error', { error: err.message });
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ─────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────

module.exports = redis;