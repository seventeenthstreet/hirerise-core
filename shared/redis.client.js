'use strict';

/**
 * shared/redis.client.js
 *
 * Redis client — production hardened
 *
 * ✅ Zero Firebase legacy
 * ✅ Safe disabled mode
 * ✅ No top-level return risk
 * ✅ Timer leak fixed
 * ✅ Better reconnect control
 * ✅ Safer constructor normalization
 * ✅ Graceful shutdown deduplicated
 * ✅ Better connection state tracking
 */

const Redis = require('ioredis');

const logger = (() => {
  try {
    return require('./logger');
  } catch {
    return console;
  }
})();

const ENABLED = process.env.CACHE_PROVIDER === 'redis';

function buildDisabledClient() {
  logger.warn('[redis] disabled (CACHE_PROVIDER != redis)');

  return {
    isReady: () => false,
    status: 'disabled',

    get: async () => null,
    set: async () => null,
    del: async () => 0,
    setex: async () => null,
    expire: async () => 0,
    quit: async () => null,

    safeExec: async () => {
      const err = new Error('REDIS_DISABLED');
      err.code = 'REDIS_DISABLED';
      throw err;
    },
  };
}

if (!ENABLED) {
  module.exports = buildDisabledClient();
} else {
  // ─────────────────────────────────────────────
  // CONFIG NORMALIZATION
  // ─────────────────────────────────────────────
  const redisOptions = process.env.REDIS_URL
    ? process.env.REDIS_URL
    : {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: Number.parseInt(process.env.REDIS_PORT || '6379', 10),
        password: process.env.REDIS_PASSWORD || undefined,
        tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
      };

  const redis =
    typeof redisOptions === 'string'
      ? new Redis(redisOptions, {
          maxRetriesPerRequest: 2,
          enableReadyCheck: true,
          lazyConnect: false,
          retryStrategy(times) {
            const delay = Math.min(times * 100, 2000);
            logger.warn('[redis] retrying connection', {
              attempt: times,
              delay,
            });
            return delay;
          },
          reconnectOnError(err) {
            if (err?.message?.includes('READONLY')) {
              logger.warn('[redis] reconnecting due to READONLY');
              return true;
            }
            return false;
          },
        })
      : new Redis({
          ...redisOptions,
          maxRetriesPerRequest: 2,
          enableReadyCheck: true,
          lazyConnect: false,
          retryStrategy(times) {
            const delay = Math.min(times * 100, 2000);
            logger.warn('[redis] retrying connection', {
              attempt: times,
              delay,
            });
            return delay;
          },
          reconnectOnError(err) {
            if (err?.message?.includes('READONLY')) {
              logger.warn('[redis] reconnecting due to READONLY');
              return true;
            }
            return false;
          },
        });

  let isConnected = false;

  redis.on('connect', () => {
    logger.info('[redis] connected');
  });

  redis.on('ready', () => {
    isConnected = true;
    logger.info('[redis] ready');
  });

  redis.on('close', () => {
    isConnected = false;
    logger.warn('[redis] connection closed');
  });

  redis.on('end', () => {
    isConnected = false;
    logger.warn('[redis] connection ended');
  });

  redis.on('reconnecting', () => {
    isConnected = false;
    logger.warn('[redis] reconnecting');
  });

  redis.on('error', (err) => {
    isConnected = false;
    logger.error('[redis] error', {
      error: err?.message || 'Unknown Redis error',
    });
  });

  redis.isReady = () => isConnected;

  redis.safeExec = async (fn, timeoutMs = 5000) => {
    if (!redis.isReady()) {
      const err = new Error('REDIS_NOT_READY');
      err.code = 'REDIS_NOT_READY';
      throw err;
    }

    let timeoutId;

    try {
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          const err = new Error('REDIS_TIMEOUT');
          err.code = 'REDIS_TIMEOUT';
          reject(err);
        }, timeoutMs);
      });

      const result = await Promise.race([fn(), timeoutPromise]);
      clearTimeout(timeoutId);

      return result;
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  };

  let shutdownRegistered = false;

  async function shutdown() {
    try {
      logger.info('[redis] shutting down');
      await redis.quit();
    } catch (err) {
      logger.error('[redis] shutdown error', {
        error: err?.message,
      });
    }
  }

  if (!shutdownRegistered) {
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    shutdownRegistered = true;
  }

  module.exports = redis;
}