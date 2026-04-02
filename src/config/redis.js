'use strict';

/**
 * redis.client.js (PRODUCTION READY)
 *
 * ✅ Lazy connection (no auto-connect)
 * ✅ Retry strategy
 * ✅ Graceful shutdown
 * ✅ Health checks
 * ✅ Safe logging
 */

const { createClient } = require('redis');

let logger;
try {
  logger = require('../logger').logger;
} catch {
  logger = console;
}

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

let client = null;
let isConnecting = false;

// ─────────────────────────────────────────────
// CREATE CLIENT
// ─────────────────────────────────────────────

function createRedisClient() {
  return createClient({
    url: REDIS_URL,

    socket: {
      reconnectStrategy(retries) {
        if (retries > 5) {
          logger.error('[Redis] Max retries reached');
          return new Error('Redis reconnect failed');
        }

        const delay = Math.min(retries * 500, 3000);
        logger.warn(`[Redis] Reconnecting in ${delay}ms...`);
        return delay;
      },
    },
  });
}

// ─────────────────────────────────────────────
// CONNECT (LAZY)
// ─────────────────────────────────────────────

async function connectRedis() {
  if (client?.isOpen) return client;
  if (isConnecting) return client;

  isConnecting = true;

  try {
    client = createRedisClient();

    client.on('connect', () => {
      logger.info('[Redis] Connected');
    });

    client.on('error', (err) => {
      logger.error('[Redis] Error', { message: err.message });
    });

    await client.connect();

    return client;
  } catch (err) {
    logger.error('[Redis] Connection failed', {
      message: err.message,
    });

    client = null;
    return null; // allow fallback
  } finally {
    isConnecting = false;
  }
}

// ─────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────

function isRedisReady() {
  return client && client.isOpen;
}

// ─────────────────────────────────────────────
// SAFE COMMAND WRAPPER (OPTIONAL)
// ─────────────────────────────────────────────

async function safeGet(key) {
  try {
    if (!isRedisReady()) return null;
    return await client.get(key);
  } catch (err) {
    logger.error('[Redis] GET failed', { key, error: err.message });
    return null;
  }
}

async function safeSet(key, value, ttlSeconds) {
  try {
    if (!isRedisReady()) return false;

    if (ttlSeconds) {
      await client.set(key, value, { EX: ttlSeconds });
    } else {
      await client.set(key, value);
    }

    return true;
  } catch (err) {
    logger.error('[Redis] SET failed', { key, error: err.message });
    return false;
  }
}

// ─────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────

async function disconnectRedis() {
  try {
    if (client && client.isOpen) {
      await client.quit();
      logger.info('[Redis] Disconnected');
    }
  } catch (err) {
    logger.error('[Redis] Disconnect failed', {
      message: err.message,
    });
  }
}

process.on('SIGINT', disconnectRedis);
process.on('SIGTERM', disconnectRedis);

// ─────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────

module.exports = {
  connectRedis,
  isRedisReady,
  safeGet,
  safeSet,
};