'use strict';

/**
 * src/modules/conversion/utils/conversionCache.provider.js
 *
 * Centralized cache abstraction for conversion intent scores.
 *
 * Architecture:
 * - Redis in production
 * - in-memory TTL fallback in dev/test
 * - versioned cache keys
 * - payload validation
 * - safe Redis client compatibility
 * - bounded local cache
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

const REDIS_CANDIDATE_PATHS = [
  '../../../utils/redis.client',
  '../../../shared/redis.client',
  '../../../../shared/redis.client',
];

if (process.env.NODE_ENV === 'production') {
  for (const path of REDIS_CANDIDATE_PATHS) {
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      redisClient = require(path);

      if (redisClient) {
        redisAvailable = true;
        logger.info('conversionCache.provider Redis caching enabled', {
          path,
        });
        break;
      }
    } catch {
      // try next candidate
    }
  }

  if (!redisAvailable) {
    logger.warn(
      'conversionCache.provider Redis unavailable, using local fallback'
    );
  }
}

// ---------------------------------------------------------------------------
// In-Memory Fallback (Dev/Test)
// ---------------------------------------------------------------------------

const localCache = new Map();
const LOCAL_CACHE_MAX_ENTRIES = 1000;

/**
 * Lightweight TTL sweep + bounded size eviction.
 */
function cleanupLocalCache() {
  const now = Date.now();

  for (const [key, entry] of localCache.entries()) {
    if (entry.expiresAt <= now) {
      localCache.delete(key);
    }
  }

  while (localCache.size > LOCAL_CACHE_MAX_ENTRIES) {
    const oldestKey = localCache.keys().next().value;
    localCache.delete(oldestKey);
  }
}

function localGet(key) {
  const entry = localCache.get(key);

  if (!entry) {
    return null;
  }

  if (Date.now() > entry.expiresAt) {
    localCache.delete(key);
    return null;
  }

  return entry.value;
}

function localSet(key, value, ttlSeconds) {
  cleanupLocalCache();

  localCache.set(key, {
    value,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
}

function localDel(key) {
  localCache.delete(key);
}

// ---------------------------------------------------------------------------
// Key Builder
// ---------------------------------------------------------------------------

const NAMESPACE = 'hirerise:conversion:score:';

function keyFor(userId) {
  return `${NAMESPACE}v${SCORE_VERSION}:${userId}`;
}

// ---------------------------------------------------------------------------
// Safe Payload Parse
// ---------------------------------------------------------------------------

function safeParse(raw, userId) {
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
  } catch (error) {
    logger.warn('conversionCache.provider invalid cache payload', {
      userId,
      error: error.message,
    });

    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function getScores(userId) {
  if (!userId) {
    throw new Error('userId is required');
  }

  const key = keyFor(userId);

  try {
    const raw = redisAvailable
      ? await redisClient.get(key)
      : localGet(key);

    if (!raw) {
      return null;
    }

    return safeParse(raw, userId);
  } catch (error) {
    logger.warn('conversionCache.provider.getScores failed', {
      userId,
      error: error.message,
    });

    return null;
  }
}

async function setScores(
  userId,
  scores,
  ttlSeconds = SCORE_CACHE_TTL_SECONDS
) {
  if (!userId) {
    throw new Error('userId is required');
  }

  const key = keyFor(userId);

  try {
    const value = JSON.stringify(scores);

    if (redisAvailable) {
      // node-redis v4
      if (typeof redisClient.set === 'function') {
        try {
          await redisClient.set(key, value, {
            EX: ttlSeconds,
          });
          return;
        } catch {
          // fallback to ioredis style
          await redisClient.set(key, value, 'EX', ttlSeconds);
          return;
        }
      }
    }

    localSet(key, value, ttlSeconds);
  } catch (error) {
    logger.warn('conversionCache.provider.setScores failed', {
      userId,
      error: error.message,
    });
  }
}

async function invalidateScores(userId) {
  if (!userId) {
    throw new Error('userId is required');
  }

  const key = keyFor(userId);

  try {
    if (redisAvailable) {
      await redisClient.del(key);
      return;
    }

    localDel(key);
  } catch (error) {
    logger.warn(
      'conversionCache.provider.invalidateScores failed',
      {
        userId,
        error: error.message,
      }
    );
  }
}

module.exports = Object.freeze({
  getScores,
  setScores,
  invalidateScores,
});