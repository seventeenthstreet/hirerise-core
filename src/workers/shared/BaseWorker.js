'use strict';

/**
 * src/workers/shared/BaseWorker.js
 *
 * Production-grade worker base class with:
 * - Redis-backed idempotency
 * - deterministic payload hashing
 * - TTL jitter
 * - connection reuse
 * - resilient cache failure fallback
 * - standardized structured logging
 *
 * This file is database-agnostic and fully compatible with Supabase workflows.
 */

const crypto = require('crypto');
const logger = require('../../utils/logger');

const IDEMPOTENCY_TTL_SECONDS = 48 * 60 * 60; // 48 hours
const IDEMPOTENCY_JITTER_MAX = 10 * 60; // 10 minutes
const KEY_PREFIX = 'worker:idempotency:';

let redisClient = null;

/**
 * Lazy singleton Redis client reuse
 * Prevents repeated require/init overhead across worker executions
 */
function getRedis() {
  if (redisClient) return redisClient;

  try {
    const cacheManager = require('../../core/cache/cache.manager');
    const client = cacheManager.getClient();

    if (client && typeof client.get === 'function') {
      redisClient = client;
    }
  } catch (error) {
    logger.warn('[BaseWorker] Redis unavailable, idempotency disabled', {
      error: error?.message || 'Unknown Redis init error',
    });
  }

  return redisClient;
}

/**
 * Stable deep object stringify
 * Ensures deterministic hashing regardless of key insertion order
 */
function stableStringify(value) {
  if (value === null || value === undefined) {
    return JSON.stringify(value);
  }

  if (typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  const sortedKeys = Object.keys(value).sort();

  const entries = sortedKeys.map((key) => {
    return `${JSON.stringify(key)}:${stableStringify(value[key])}`;
  });

  return `{${entries.join(',')}}`;
}

/**
 * Safe JSON parse utility
 */
function safeParseJSON(raw, fallback = null) {
  if (!raw) return fallback;

  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

class BaseWorker {
  constructor(jobType) {
    if (!jobType || typeof jobType !== 'string') {
      throw new Error('BaseWorker requires a valid jobType string');
    }

    this.jobType = jobType;
  }

  /**
   * Build deterministic idempotency key
   * Same logical payload = same key
   */
  static buildIdempotencyKey(userId, inputPayload) {
    if (!userId) {
      throw new Error('buildIdempotencyKey requires userId');
    }

    const normalized =
      typeof inputPayload === 'string'
        ? inputPayload
        : stableStringify(inputPayload);

    return crypto
      .createHash('sha256')
      .update(`${userId}:${normalized}`)
      .digest('hex');
  }

  _redisKey(idempotencyKey) {
    return `${KEY_PREFIX}${this.jobType}:${idempotencyKey}`;
  }

  async _checkIdempotency(idempotencyKey) {
    const redis = getRedis();
    if (!redis) return null;

    try {
      const cached = await redis.get(this._redisKey(idempotencyKey));
      return safeParseJSON(cached, null);
    } catch (error) {
      logger.warn(`[${this.jobType}] Idempotency read failed`, {
        idempotencyKey,
        error: error?.message || 'Unknown Redis read error',
      });
      return null;
    }
  }

  async _markComplete(idempotencyKey, result) {
    const redis = getRedis();
    if (!redis) return;

    const payload = JSON.stringify({
      completedAt: new Date().toISOString(),
      jobType: this.jobType,
      result,
    });

    const jitter = Math.floor(Math.random() * IDEMPOTENCY_JITTER_MAX);
    const ttl = IDEMPOTENCY_TTL_SECONDS + jitter;

    try {
      /**
       * Compatible with common Redis clients
       * node-redis / ioredis safe pattern
       */
      await redis.set(this._redisKey(idempotencyKey), payload, 'EX', ttl);
    } catch (error) {
      logger.warn(`[${this.jobType}] Failed to persist idempotency state`, {
        idempotencyKey,
        error: error?.message || 'Unknown Redis write error',
      });
    }
  }

  async process(_payload) {
    throw new Error(`[${this.jobType}] process() must be implemented`);
  }

  async run(payload, idempotencyKey) {
    if (!idempotencyKey) {
      throw new Error(`[${this.jobType}] idempotencyKey is required`);
    }

    const startedAt = Date.now();

    const cached = await this._checkIdempotency(idempotencyKey);

    if (cached?.result) {
      logger.info(`[${this.jobType}] Idempotency cache hit`, {
        idempotencyKey,
        completedAt: cached.completedAt,
      });

      return {
        result: cached.result,
        fromCache: true,
      };
    }

    logger.info(`[${this.jobType}] Worker started`, {
      idempotencyKey,
    });

    let result;

    try {
      result = await this.process(payload);
    } catch (error) {
      logger.error(`[${this.jobType}] Worker execution failed`, {
        idempotencyKey,
        durationMs: Date.now() - startedAt,
        error: error?.message || 'Unknown worker error',
      });

      throw error;
    }

    await this._markComplete(idempotencyKey, result);

    logger.info(`[${this.jobType}] Worker completed`, {
      idempotencyKey,
      durationMs: Date.now() - startedAt,
    });

    return {
      result,
      fromCache: false,
    };
  }

  async invalidate(idempotencyKey) {
    const redis = getRedis();
    if (!redis) return;

    try {
      await redis.del(this._redisKey(idempotencyKey));

      logger.info(`[${this.jobType}] Idempotency invalidated`, {
        idempotencyKey,
      });
    } catch (error) {
      logger.warn(`[${this.jobType}] Failed to invalidate idempotency`, {
        idempotencyKey,
        error: error?.message || 'Unknown Redis delete error',
      });
    }
  }
}

module.exports = BaseWorker;