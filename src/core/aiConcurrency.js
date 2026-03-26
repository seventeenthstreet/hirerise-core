'use strict';

/**
 * aiConcurrency.js
 *
 * Global AI concurrency semaphore — prevents simultaneous AI calls from
 * exhausting Anthropic rate limits or causing thundering-herd cost spikes.
 *
 * MECHANISM:
 *   Redis key `ai:concurrency:current` tracks the count of in-flight AI calls
 *   across all server instances (Cloud Run replicas included).
 *
 *   Before each AI call:
 *     1. INCR ai:concurrency:current
 *     2. If result > MAX_CONCURRENT_AI_CALLS → DECR + reject with 503
 *     3. If result ≤ limit → proceed
 *
 *   After each AI call (success or failure):
 *     DECR ai:concurrency:current
 *
 * KEY PROPERTIES:
 *   - Distributed: works across all Cloud Run replicas
 *   - TTL failsafe: key expires after 60s to prevent stuck counts from crashes
 *   - Graceful degradation: if Redis is unavailable, falls through (non-fatal)
 *   - No lock contention: INCR/DECR are O(1) atomic Redis operations
 *
 * CONFIGURATION:
 *   AI_MAX_CONCURRENT_CALLS=10  (default: 10)
 *
 * USAGE:
 *   const { acquireAiSlot, releaseAiSlot, withAiConcurrency } = require('../core/aiConcurrency');
 *
 *   // Pattern A: Manual acquire/release (when you need fine-grained control)
 *   const acquired = await acquireAiSlot(feature, userId);
 *   try {
 *     result = await callClaude(...);
 *   } finally {
 *     if (acquired) await releaseAiSlot(feature, userId);
 *   }
 *
 *   // Pattern B: Wrapper (recommended for most cases)
 *   const result = await withAiConcurrency(feature, userId, async () => callClaude(...));
 *
 * @module core/aiConcurrency
 */

const logger = require('../utils/logger');

const MAX_CONCURRENT  = parseInt(process.env.AI_MAX_CONCURRENT_CALLS || '10', 10);
const CONCURRENCY_KEY = 'ai:concurrency:current';
const KEY_TTL_S       = 60; // failsafe TTL — prevents stuck counts from crashed instances

// ─── Redis client (lazy, same pattern as creditGuard / tokenCache) ─────────────

let _redis = null;
function getRedis() {
  if (_redis) return _redis;
  try {
    const mgr = require('./cache/cache.manager');
    const client = mgr.getClient();
    // We need the raw ioredis client for INCR/DECR atomicity — not the CacheManager wrapper
    if (client?.client?.incr) {
      _redis = client.client; // raw ioredis instance
    }
  } catch {
    // Redis unavailable — will degrade gracefully
  }
  return _redis;
}

// ─── Semaphore operations ──────────────────────────────────────────────────────

/**
 * acquireAiSlot(feature, userId)
 *
 * Atomically increments the global concurrency counter and checks the limit.
 * Returns true if a slot was acquired (caller must call releaseAiSlot after).
 * Returns false if the limit is reached (caller should not proceed with AI call).
 *
 * On Redis failure: returns true (fail open — availability > strict limiting).
 *
 * @param {string} feature  — for logging/metrics (e.g. 'chi_calculation')
 * @param {string} userId   — for logging
 * @returns {Promise<boolean>}
 */
async function acquireAiSlot(feature, userId) {
  const redis = getRedis();
  if (!redis) {
    logger.debug('[AIConcurrency] Redis unavailable — skipping semaphore (fail open)', { feature, userId });
    return true; // fail open — don't block AI calls when Redis is down
  }

  try {
    // INCR is atomic — safe across multiple instances
    const current = await redis.incr(CONCURRENCY_KEY);

    // Refresh TTL on every increment — if the process crashes, key expires
    // Use pipeline to avoid an extra round-trip
    await redis.expire(CONCURRENCY_KEY, KEY_TTL_S);

    if (current > MAX_CONCURRENT) {
      // Over limit — immediately release the slot we just claimed
      await redis.decr(CONCURRENCY_KEY);
      logger.warn('[AIConcurrency] Concurrency limit reached — rejecting AI call', {
        feature, userId, current, max: MAX_CONCURRENT,
      });
      return false;
    }

    logger.debug('[AIConcurrency] Slot acquired', { feature, userId, current, max: MAX_CONCURRENT });
    return true;
  } catch (err) {
    // Redis error — fail open so a Redis blip doesn't kill all AI calls
    logger.error('[AIConcurrency] Redis error — failing open', { feature, userId, error: err.message });
    return true;
  }
}

/**
 * releaseAiSlot(feature, userId)
 *
 * Decrements the concurrency counter. Always call this after acquireAiSlot returns true,
 * regardless of whether the AI call succeeded or failed.
 *
 * @param {string} feature
 * @param {string} userId
 */
async function releaseAiSlot(feature, userId) {
  const redis = getRedis();
  if (!redis) return;

  try {
    const current = await redis.decr(CONCURRENCY_KEY);
    // Guard against negative values (e.g. from crashed instances that never released)
    if (current < 0) {
      await redis.set(CONCURRENCY_KEY, '0');
      logger.warn('[AIConcurrency] Counter went negative — reset to 0', { feature, userId });
    }
    logger.debug('[AIConcurrency] Slot released', { feature, userId, current });
  } catch (err) {
    logger.error('[AIConcurrency] Release failed', { feature, userId, error: err.message });
  }
}

/**
 * withAiConcurrency(feature, userId, fn)
 *
 * Recommended wrapper. Acquires a slot, runs fn(), releases the slot in finally.
 * Throws AppError 503 if the concurrency limit is reached.
 *
 * @param {string}   feature
 * @param {string}   userId
 * @param {Function} fn  — async function that makes the AI call
 * @returns {Promise<any>}
 */
async function withAiConcurrency(feature, userId, fn) {
  const { AppError, ErrorCodes } = require('../middleware/errorHandler');

  const acquired = await acquireAiSlot(feature, userId);
  if (!acquired) {
    throw new AppError(
      'AI service is at capacity. Please try again in a few seconds.',
      503,
      { feature, retryAfterSeconds: 5 },
      ErrorCodes.SERVICE_UNAVAILABLE ?? 'SERVICE_UNAVAILABLE'
    );
  }

  try {
    return await fn();
  } finally {
    await releaseAiSlot(feature, userId);
  }
}

/**
 * getCurrentConcurrency()
 *
 * Returns the current in-flight AI call count. Used by admin health endpoints.
 *
 * @returns {Promise<number>}
 */
async function getCurrentConcurrency() {
  const redis = getRedis();
  if (!redis) return 0;
  try {
    const val = await redis.get(CONCURRENCY_KEY);
    return parseInt(val || '0', 10);
  } catch {
    return 0;
  }
}

module.exports = {
  acquireAiSlot,
  releaseAiSlot,
  withAiConcurrency,
  getCurrentConcurrency,
  MAX_CONCURRENT,
  CONCURRENCY_KEY,
};








