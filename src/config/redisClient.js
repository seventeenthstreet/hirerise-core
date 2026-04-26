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
 *
 * Phase 3 Micro-hardening:
 * - All cache API methods (get/set/del/incr/hget/hset) now guard on BOTH
 *   _redis (truthy) AND _ready (flag) before dispatching commands.
 *   Previously `if (_redis)` was sufficient at bootstrap but could dispatch
 *   to a disconnected client after a transient failure event (where _redis
 *   remains non-null but _ready has been set false by the 'error'/'close'
 *   listener). Each method now catches and returns a safe zero-value on error.
 * - logger import added (was referenced in retryStrategy but not imported).
 */

const Redis = require('ioredis');
const NodeCache = require('node-cache');
const env = require('./env');
const logger = require('../utils/logger');

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
    logger.info('[Redis] connectRedis() called — reusing in-flight promise');
    return _connectPromise;
  }

  _connectPromise = (async () => {
    logger.info('[Redis] connectRedis() entered', {
      provider,
      isProd,
      hasRedisUrl: !!env.REDIS_URL,
    });

    if (provider !== 'redis') {
      // ← THIS is why nothing was connecting: CACHE_PROVIDER was not 'redis'
      // even though the env log said CACHE: 'redis'. The value read here at
      // module-parse time did not match. Log it explicitly.
      logger.warn('[Redis] SKIPPING Redis connection — provider is not "redis"', {
        provider,
        CACHE_PROVIDER: env.CACHE_PROVIDER || '(not set)',
        resolution: 'Set CACHE_PROVIDER=redis in your .env file',
      });

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
        logger.info('[Redis] Fell back to NodeCache (dev/test)');
      }

      return null;
    }

    if (!env.REDIS_URL) {
      logger.error('[Redis] REDIS_URL is not set — cannot connect');
      throw new Error('[Redis] REDIS_URL not set');
    }

    logger.info('[Redis] Attempting connection...', {
      url: env.REDIS_URL.replace(/:\/\/.*@/, '://**:**@'), // redact credentials
    });

    if (!_redis) {
      _redis = new Redis(env.REDIS_URL, {
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        connectTimeout: 5000,
        commandTimeout: 3000,
        retryStrategy(times) {
          if (times > 10) {
            logger.error('[Redis] max reconnect attempts reached, stopping', { attempt: times });
            return null;
          }
          return Math.min(times * 300, 3000);
        },
      });

      _redis.on('connect', () => {
        logger.info('[Redis] TCP connection established');
      });

      _redis.on('ready', () => {
        _ready = true;
        _error = null;
        logger.info('[Redis] Ready — accepting commands');
      });

      _redis.on('error', (err) => {
        _ready = false;
        _error = err.message;
        logger.error('[Redis] Client error', {
          error:   err.message,
          code:    err.code    || null,
          syscall: err.syscall || null,
        });
      });

      _redis.on('close', () => {
        _ready = false;
        logger.warn('[Redis] Connection closed');
      });

      _redis.on('reconnecting', () => {
        logger.warn('[Redis] Reconnecting...');
      });
    }

    try {
      await _redis.connect();
      await _redis.ping();

      _ready = true;
      _error = null;

      logger.info('[Redis] Connected successfully — PONG received');
      return _redis;
    } catch (err) {
      _ready = false;
      _error = err.message;

      logger.error('[Redis] Connection failed', {
        error:   err.message,
        code:    err.code    || null,
        syscall: err.syscall || null,
        url:     env.REDIS_URL?.replace(/:\/\/.*@/, '://**:**@') || '(not set)',
        isProd,
        resolution: isProd
          ? 'Fatal — process will exit'
          : 'Falling back to NodeCache for dev',
      });

      if (isProd) {
        throw err;
      }

      _redis = null;

      if (!_memory) {
        _memory = new NodeCache({
          stdTTL: 300,
          checkperiod: 60,
        });
        logger.info('[Redis] Fell back to NodeCache after connection failure (dev)');
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
  if (_redis && _ready) return _redis.get(key).catch(() => null);
  return _memory?.get(key) ?? null;
}

async function set(key, value, ttlSeconds = 300) {
  if (_redis && _ready) {
    return _redis.set(key, String(value), 'EX', ttlSeconds).catch(() => null);
  }

  _memory?.set(key, value, ttlSeconds);
}

async function del(key) {
  if (_redis && _ready) return _redis.del(key).catch(() => 0);
  _memory?.del(key);
}

/**
 * Atomic increment with TTL-on-first-write.
 *
 * Uses INCR (atomic) then EXPIRE only on the first write (when the value
 * becomes 1) so the TTL is set exactly once and never accidentally extended
 * on subsequent increments — a standard Redis rate-limit pattern.
 *
 * Falls back to a non-atomic get/set on NodeCache in dev/test where
 * race conditions don't matter.
 *
 * Returns the new counter value.
 */
async function incr(key, ttlSeconds = 60) {
  if (_redis && _ready) {
    try {
      const newVal = await _redis.incr(key);
      if (newVal === 1) {
        // Only set TTL when the key is brand-new to avoid resetting the window.
        await _redis.expire(key, ttlSeconds);
      }
      return newVal;
    } catch {
      return 0;
    }
  }
  // NodeCache fallback (dev/test only)
  const current = (_memory?.get(key) ?? 0);
  const next = current + 1;
  _memory?.set(key, next, ttlSeconds);
  return next;
}

async function hget(hash, field) {
  if (_redis && _ready) return _redis.hget(hash, field).catch(() => null);

  const store = _memory?.get(hash);
  return store?.[field] ?? null;
}

async function hset(hash, field, value, ttlSeconds = 300) {
  if (_redis && _ready) {
    try {
      await _redis.hset(hash, field, String(value));
      return _redis.expire(hash, ttlSeconds);
    } catch {
      return null;
    }
  }

  const store = _memory?.get(hash) || {};
  store[field] = value;
  _memory?.set(hash, store, ttlSeconds);
}

/**
 * Returns the raw ioredis client instance, or null if not yet connected
 * or if running in memory-fallback mode.
 *
 * Used by getLeaseRedisClient() in server.js (Wave33/40/45) to obtain
 * a client for pub/sub and lease operations.
 */
function getRedisClient() {
  return (_redis && _ready) ? _redis : null;
}

module.exports = {
  connectRedis,
  closeRedis,
  getRedisStatus,
  getRedisClient,
  get,
  set,
  del,
  incr,
  hget,
  hset,
};