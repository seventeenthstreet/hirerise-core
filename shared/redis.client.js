'use strict';

/**
 * redis.client.js
 *
 * Production-safe Redis client.
 * Supports:
 *   - REDIS_URL
 *   - REDIS_HOST / PORT / PASSWORD
 *   - Optional TLS
 *   - Graceful fallback
 */

const Redis = require('ioredis');

const logger = (() => {
  try {
    return require('./logger');
  } catch {
    return console;
  }
})();

if (process.env.CACHE_PROVIDER !== 'redis') {
  logger.info('[redis] CACHE_PROVIDER not set to redis — disabled');
  module.exports = null;
  return;
}

let redisConfig = null;

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

const redis = new Redis(redisConfig, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
  reconnectOnError: () => true,
});

redis.on('connect', () => {
  logger.info('[redis] connected');
});

redis.on('ready', () => {
  logger.info('[redis] ready');
});

redis.on('error', (err) => {
  logger.error('[redis] error', { error: err.message });
});

redis.on('close', () => {
  logger.warn('[redis] connection closed');
});

module.exports = redis;