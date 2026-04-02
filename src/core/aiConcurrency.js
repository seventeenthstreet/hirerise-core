'use strict';

const logger = require('../utils/logger');

const MAX_CONCURRENT  = parseInt(process.env.AI_MAX_CONCURRENT_CALLS || '10', 10);
const CONCURRENCY_KEY = 'ai:concurrency:current';
const KEY_TTL_S       = 60;

let _redis = null;
let _lastFailure = 0;

// ─────────────────────────────────────────────
// Redis getter (SAFE + ASYNC)
// ─────────────────────────────────────────────
async function getRedis() {
  if (_redis) return _redis;

  // circuit breaker (avoid retry spam)
  if (Date.now() - _lastFailure < 5000) return null;

  try {
    const mgr = require('./cache/cache.manager');
    const cache = await mgr.getClient();

    if (cache?.client?.incr) {
      _redis = cache.client;
      return _redis;
    }
  } catch (err) {
    _lastFailure = Date.now();
    logger.warn('[AIConcurrency] Redis init failed', { error: err.message });
  }

  return null;
}

// ─────────────────────────────────────────────
// Safe exec wrapper
// ─────────────────────────────────────────────
async function safeExec(fn) {
  try {
    return await Promise.race([
      fn(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('REDIS_TIMEOUT')), 1500)
      )
    ]);
  } catch (err) {
    logger.error('[AIConcurrency] Redis operation failed', { error: err.message });
    return null;
  }
}

// ─────────────────────────────────────────────
// Acquire
// ─────────────────────────────────────────────
async function acquireAiSlot(feature, userId) {
  const redis = await getRedis();

  if (!redis) {
    logger.debug('[AIConcurrency] Redis unavailable — fail open', { feature });
    return true;
  }

  try {
    // 🔥 atomic pipeline
    const pipeline = redis.pipeline();
    pipeline.incr(CONCURRENCY_KEY);
    pipeline.expire(CONCURRENCY_KEY, KEY_TTL_S);

    const results = await safeExec(() => pipeline.exec());
    if (!results) return true;

    const current = results[0][1];

    if (current > MAX_CONCURRENT) {
      await safeExec(() => redis.decr(CONCURRENCY_KEY));

      logger.warn('[AIConcurrency] Limit reached', {
        feature,
        userId,
        current,
        max: MAX_CONCURRENT,
      });

      return false;
    }

    logger.debug('[AIConcurrency] Slot acquired', {
      feature,
      userId,
      current,
    });

    return true;

  } catch (err) {
    logger.error('[AIConcurrency] Acquire failed — fail open', {
      feature,
      error: err.message,
    });
    return true;
  }
}

// ─────────────────────────────────────────────
// Release
// ─────────────────────────────────────────────
async function releaseAiSlot(feature, userId) {
  const redis = await getRedis();
  if (!redis) return;

  try {
    const current = await safeExec(() => redis.decr(CONCURRENCY_KEY));

    if (current < 0) {
      await safeExec(() => redis.set(CONCURRENCY_KEY, '0'));
      logger.warn('[AIConcurrency] Counter negative — reset', { feature });
    }

    logger.debug('[AIConcurrency] Slot released', {
      feature,
      userId,
      current,
    });

  } catch (err) {
    logger.error('[AIConcurrency] Release failed', {
      feature,
      error: err.message,
    });
  }
}

// ─────────────────────────────────────────────
// Wrapper
// ─────────────────────────────────────────────
async function withAiConcurrency(feature, userId, fn) {
  const { AppError, ErrorCodes } = require('../middleware/errorHandler');

  const acquired = await acquireAiSlot(feature, userId);

  if (!acquired) {
    throw new AppError(
      'AI service is at capacity. Please try again shortly.',
      503,
      { retryAfterSeconds: 5 },
      ErrorCodes.SERVICE_UNAVAILABLE ?? 'SERVICE_UNAVAILABLE'
    );
  }

  try {
    return await fn();
  } finally {
    await releaseAiSlot(feature, userId);
  }
}

// ─────────────────────────────────────────────
// Metrics
// ─────────────────────────────────────────────
async function getCurrentConcurrency() {
  const redis = await getRedis();
  if (!redis) return 0;

  try {
    const val = await safeExec(() => redis.get(CONCURRENCY_KEY));
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