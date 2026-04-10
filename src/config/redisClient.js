'use strict';

/**
 * config/redisClient.js
 * PR 2: Backend Infra Safety
 *
 * Guarantees:
 * - No unsafe localhost fallback
 * - Production hard-fails without Redis
 * - Dev/test supports memory cache mode
 * - Explicit readiness tracking
 * - Safe for BullMQ + health probes
 */

const { createClient } = require('redis');
const logger = require('../utils/logger');

const redisUrl = process.env.REDIS_URL || null;
const cacheProvider = process.env.CACHE_PROVIDER || 'memory';
const isProduction = process.env.NODE_ENV === 'production';

let isReady = false;

const client = redisUrl
  ? createClient({ url: redisUrl })
  : null;

if (client) {
  client.on('error', (err) => {
    isReady = false;
    logger.error('[Redis] Error', { error: err.message });
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

  if (!client.isOpen) {
    await client.connect();
  }

  return client;
}

/**
 * Readiness helper for health probes.
 */
function redisReady() {
  return isReady;
}

module.exports = {
  redis: client,
  connectRedis,
  redisReady,
};