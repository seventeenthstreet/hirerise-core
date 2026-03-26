'use strict';

/**
 * conversionCache.provider.js
 *
 * Centralized cache abstraction for conversion intent scores.
 * Services MUST NOT implement their own caching.
 *
 * Production: Redis
 * Dev/Test: In-memory fallback with TTL
 */

const logger = require('./conversion.logger');
const {
  SCORE_CACHE_TTL_SECONDS,
  SCORE_VERSION,
} = require('./eventWeights.config');

// ---------------------------------------------------------------------------
// Redis Client Resolution
// ---------------------------------------------------------------------------

let redisClient = null;
let redisAvailable = false;

/**
 * Attempt to load Redis only in production.
 */
if (process.env.NODE_ENV === 'production') {
  try {
    // Adjust path if your shared redis client lives elsewhere
    redisClient = require('../../../../shared/redis.client');

    if (redisClient) {
      redisAvailable = true;
      logger.info('conversionCache.provider: Redis caching enabled');
    }
  } catch (err) {
    redisAvailable = false;
    logger.error('conversionCache.provider: Redis client load failed', {
      error: err.message,
    });
  }
}

// ---------------------------------------------------------------------------
// In-Memory Fallback (Dev/Test Only)
// ---------------------------------------------------------------------------

/**
 * Map<string, { value: string, expiresAt: number }>
 */
const _localCache = new Map();

/**
 * Prevent unbounded growth in development.
 */
const LOCAL_CACHE_MAX_ENTRIES = 1000;

/**
 * Clean expired entries (lightweight sweep).
 */
function _cleanupLocalCache() {
  const now = Date.now();
  for (const [key, entry] of _localCache.entries()) {
    if (entry.expiresAt <= now) {
      _localCache.delete(key);
    }
  }

  if (_localCache.size > LOCAL_CACHE_MAX_ENTRIES) {
    // Remove oldest entry (naive eviction)
    const firstKey = _localCache.keys().next().value;
    _localCache.delete(firstKey);
  }
}

function _localGet(key) {
  const entry = _localCache.get(key);
  if (!entry) return null;

  if (Date.now() > entry.expiresAt) {
    _localCache.delete(key);
    return null;
  }

  return entry.value;
}

function _localSet(key, value, ttlSeconds) {
  _cleanupLocalCache();
  _localCache.set(key, {
    value,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
}

function _localDel(key) {
  _localCache.delete(key);
}

// ---------------------------------------------------------------------------
// Key Builder
// ---------------------------------------------------------------------------

const NAMESPACE = 'hirerise:conversion:score:';

/**
 * Includes SCORE_VERSION to allow safe scoring upgrades.
 */
function _key(userId) {
  return `${NAMESPACE}v${SCORE_VERSION}:${userId}`;
}

// ---------------------------------------------------------------------------
// Safe JSON Parse
// ---------------------------------------------------------------------------

function _safeParse(raw, userId) {
  try {
    const parsed = JSON.parse(raw);

    if (
      typeof parsed.engagementScore !== 'number' ||
      typeof parsed.monetizationScore !== 'number' ||
      typeof parsed.totalIntentScore !== 'number'
    ) {
      throw new Error('Malformed cache payload');
    }

    return parsed;
  } catch (err) {
    logger.warn('conversionCache.provider: invalid cache payload', {
      userId,
      error: err.message,
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get cached scores.
 * @param {string} userId
 * @returns {Promise<{ engagementScore: number, monetizationScore: number, totalIntentScore: number }|null>}
 */
async function getScores(userId) {
  const key = _key(userId);

  try {
    let raw = null;

    if (redisAvailable) {
      raw = await redisClient.get(key);
    } else {
      raw = _localGet(key);
    }

    if (!raw) return null;

    return _safeParse(raw, userId);
  } catch (err) {
    logger.warn('conversionCache.provider.getScores failed', {
      userId,
      error: err.message,
    });
    return null;
  }
}

/**
 * Set cached scores.
 * @param {string} userId
 * @param {{ engagementScore: number, monetizationScore: number, totalIntentScore: number }} scores
 * @param {number} ttlSeconds
 */
async function setScores(
  userId,
  scores,
  ttlSeconds = SCORE_CACHE_TTL_SECONDS
) {
  const key = _key(userId);

  try {
    const value = JSON.stringify(scores);

    if (redisAvailable) {
      // Support both node-redis v4 and ioredis style
      if (typeof redisClient.set === 'function') {
        await redisClient.set(key, value, 'EX', ttlSeconds);
      }
    } else {
      _localSet(key, value, ttlSeconds);
    }
  } catch (err) {
    logger.warn('conversionCache.provider.setScores failed', {
      userId,
      error: err.message,
    });
  }
}

/**
 * Invalidate cache after aggregate update.
 * @param {string} userId
 */
async function invalidateScores(userId) {
  const key = _key(userId);

  try {
    if (redisAvailable) {
      await redisClient.del(key);
    } else {
      _localDel(key);
    }
  } catch (err) {
    logger.warn('conversionCache.provider.invalidateScores failed', {
      userId,
      error: err.message,
    });
  }
}

module.exports = {
  getScores,
  setScores,
  invalidateScores,
};








