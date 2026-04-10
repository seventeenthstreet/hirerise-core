'use strict';

/**
 * src/config/redisClient.js
 * HireRise PR 2 — Backend Infra Safety
 *
 * Guarantees:
 * - No unsafe localhost fallback
 * - Production hard-fails without Redis
 * - Dev/test supports memory cache mode
 * - Explicit readiness tracking
 * - Safe for BullMQ + health probes
 * - Idempotent connect bootstrap
 */

const { createClient } = require('redis');
const env = require('./env');
const logger = require('../utils/logger');

const redisUrl = env.REDIS_URL || null;
const cacheProvider = env.CACHE_PROVIDER || 'memory';
const isProduction = env.NODE_ENV === 'production';

let isReady = false;
let connectPromise = null;

const client = redisUrl
  ? createClient({
      url: redisUrl,
      socket: {
        reconnectStrategy(retries) {
          return Math.min(retries * 100, 3000);
        },
      },
    })
  : null;

if (client) {
  client.on('error', (err) => {
    isReady = false;
    logger.error('[Redis] Error', {
      error: err.message,
    });
  });

  client.on('connect', () => {
    logger.info('[Redis] Connected');
  });

  client.on('ready', () => {
    isReady = true;
    logger.info('[Redis] Ready');
  });

  client.on('end', () => {
    isReady = false;
    logger.warn('[Redis] Connection closed');
  });

  client.on('reconnecting', () => {
    isReady = false;
    logger.warn('[Redis] Reconnecting');
  });
}

/**
 * Connect Redis safely.
 *
 * Behavior:
 * - production => throws if Redis unavailable
 * - CACHE_PROVIDER=redis => throws in any env
 * - memory mode => skips cleanly
 */
async function connectRedis() {
  if (!client) {
    if (isProduction || cacheProvider === 'redis') {
      throw new Error('[Redis] REDIS_URL is not configured');
    }

    logger.info('[Redis] Skipped (memory cache mode)');
    return null;
  }

  if (client.isOpen && isReady) {
    return client;
  }

  if (connectPromise) {
    return connectPromise;
  }

  connectPromise = (async () => {
    try {
      if (!client.isOpen) {
        await client.connect();
      }

      await client.ping();

      isReady = true;
      return client;
    } catch (error) {
      isReady = false;
      logger.error('[Redis] Startup connection failed', {
        error: error.message,
      });

      throw error;
    } finally {
      connectPromise = null;
    }
  })();

  return connectPromise;
}

/**
 * Readiness helper for health probes.
 */
function redisReady() {
  return isReady;
}

/**
 * Structured status helper for /ready endpoint.
 */
function getRedisStatus() {
  return {
    provider: cacheProvider,
    connected: isReady,
    client: client ? 'redis' : 'memory',
  };
}

module.exports = {
  redis: client,
  connectRedis,
  redisReady,
  getRedisStatus,
};