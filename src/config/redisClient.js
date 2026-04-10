'use strict';

/**
 * src/config/redisClient.js
 * HireRise PR 2 — Backend Infra Safety
 *
 * Guarantees:
 * - Redis-first bootstrap safety
 * - production hard-fails
 * - dev/test memory fallback
 * - readiness reporting
 * - idempotent connect
 * - graceful shutdown support
 */

const Redis = require('ioredis');
const NodeCache = require('node-cache');
const env = require('./env');

const isProd = env.NODE_ENV === 'production';
const provider = (env.CACHE_PROVIDER || 'memory').toLowerCase();

let _redis = null;
let _memory = null;
let _ready = false;
let _error = null;
let _connectPromise = null;

/**
 * Called once in bootstrap() before app.listen().
 * In production: throws if Redis is unavailable.
 * In dev/test: falls back to NodeCache.
 */
async function connectRedis() {
  if (_connectPromise) {
    return _connectPromise;
  }

  _connectPromise = (async () => {
    if (provider !== 'redis') {
      if (isProd) {
        throw new Error(
          '[Redis] CACHE_PROVIDER must be redis in production'
        );
      }

      if (!_memory) {
        _memory = new NodeCache({
          stdTTL: 300,
          checkperiod: 60,
        });
      }

      return null;
    }

    if (!env.REDIS_URL) {
      throw new Error('[Redis] REDIS_URL not set');
    }

    if (!_redis) {
      _redis = new Redis(env.REDIS_URL, {
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        connectTimeout: 5000,
        commandTimeout: 3000,
        retryStrategy: () => null,
      });

      _redis.on('error', (err) => {
        _ready = false;
        _error = err.message;
      });

      _redis.on('ready', () => {
        _ready = true;
        _error = null;
      });

      _redis.on('close', () => {
        _ready = false;
      });
    }

    try {
      await _redis.connect();
      await _redis.ping();

      _ready = true;
      _error = null;

      return _redis;
    } catch (err) {
      _ready = false;
      _error = err.message;

      if (isProd) {
        throw err;
      }

      _redis = null;

      if (!_memory) {
        _memory = new NodeCache({
          stdTTL: 300,
          checkperiod: 60,
        });
      }

      return null;
    } finally {
      _connectPromise = null;
    }
  })();

  return _connectPromise;
}

/**
 * Consumed by /ready route.
 */
function getRedisStatus() {
  return {
    provider,
    connected: _ready,
    error: _error || null,
    backend: _redis ? 'ioredis' : 'node-cache',
  };
}

async function closeRedis() {
  if (_redis) {
    await _redis.quit();
    _ready = false;
  }
}

// ── Unified cache API ───────────────────────────────────────

async function get(key) {
  if (_redis) return _redis.get(key);
  return _memory?.get(key) ?? null;
}

async function set(key, value, ttlSeconds = 300) {
  if (_redis) {
    return _redis.set(key, String(value), 'EX', ttlSeconds);
  }

  _memory?.set(key, value, ttlSeconds);
}

async function del(key) {
  if (_redis) return _redis.del(key);
  _memory?.del(key);
}

async function hget(hash, field) {
  if (_redis) return _redis.hget(hash, field);

  const store = _memory?.get(hash);
  return store?.[field] ?? null;
}

async function hset(hash, field, value, ttlSeconds = 300) {
  if (_redis) {
    await _redis.hset(hash, field, String(value));
    return _redis.expire(hash, ttlSeconds);
  }

  const store = _memory?.get(hash) || {};
  store[field] = value;
  _memory?.set(hash, store, ttlSeconds);
}

module.exports = {
  connectRedis,
  closeRedis,
  getRedisStatus,
  get,
  set,
  del,
  hget,
  hset,
};