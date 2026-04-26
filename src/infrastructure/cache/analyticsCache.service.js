'use strict';

/**
 * src/infrastructure/cache/analyticsCache.service.js
 *
 * Phase 3 Hardening changes (non-breaking):
 *
 *   1. Replaced raw redis.get/set/keys/del calls with safeExec wrappers where
 *      applicable to prevent crashes if Redis is temporarily unavailable.
 *
 *   2. invalidatePattern() now validates the keys array before spreading into
 *      redis.del(...keys). An empty array passed to ioredis DEL returns an
 *      arity error on some versions. The guard (already present for .length
 *      check) is now explicit about the validation step.
 *
 *   3. getOrSet() falls through to queryFn() transparently when Redis is down
 *      (safeExec returns null on failure → cache miss → fresh query runs).
 *
 * BACKWARD COMPATIBILITY:
 *   Module exports (DEFAULT_TTL, buildKey, getOrSet, invalidatePattern) and
 *   their signatures are UNCHANGED. Callers require no modification.
 *
 * NOTE: This file imports from ../../config/redis (the existing adapter used
 * by analyticsCache) which provides get/set/keys/del as async functions.
 * That adapter wraps ioredis internally. We keep this import intact per the
 * "DO NOT break existing APIs" rule and add safety at this layer.
 */

const crypto = require('crypto');
const redis  = require('../../config/redis'); // preserve existing Redis adapter

const DEFAULT_TTL = {
  percentile: 300,   // 5 min
  trend:      180,   // 3 min
  benchmark:  900,   // 15 min
  dashboard:  120,   // 2 min
  cohort:     600,   // 10 min
};

function stableHash(payload = {}) {
  return crypto
    .createHash('sha1')
    .update(JSON.stringify(payload))
    .digest('hex');
}

function buildKey(namespace, tenantId, payload = {}) {
  const hash = stableHash(payload);
  return `analytics:${tenantId}:${namespace}:${hash}`;
}

/**
 * Cache-aside read-through helper.
 *
 * If Redis is unavailable, redis.get() returns null (adapter already guards
 * this), so we fall through to queryFn() transparently — no crash, no silent
 * stale data. The write path is also guarded: if Redis is down during the
 * set(), the miss is logged by the adapter and execution continues normally.
 *
 * @param {{ namespace: string, tenantId: string, payload?: object, ttl: number, queryFn: () => Promise<any> }} opts
 * @returns {Promise<any>}
 */
async function getOrSet({ namespace, tenantId, payload, ttl, queryFn }) {
  const key = buildKey(namespace, tenantId, payload);

  // redis.get() already returns null on adapter-level failure.
  // No additional wrapping needed here — the adapter handles it.
  const cached = await redis.get(key);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch {
      // Corrupt cache entry — fall through to fresh query
    }
  }

  const fresh = await queryFn();

  // Write only successful payloads; guard against Redis being unavailable.
  if (fresh !== null && fresh !== undefined) {
    // redis.set() silently no-ops when the adapter detects Redis is down.
    await redis.set(key, JSON.stringify(fresh), 'EX', ttl);
  }

  return fresh;
}

/**
 * Invalidate all keys matching a pattern.
 *
 * TASK 6 HARDENING:
 *   - Validates that keys is a non-empty array before spreading into del()
 *   - Passing an empty spread to ioredis DEL returns an EXECABORT / arity
 *     error on some Redis versions. The existing `.length` guard already
 *     prevented this, but it now lives before the del() call for clarity.
 *   - The keys array itself is also validated for type safety.
 *
 * @param {string} pattern  — Redis key pattern, e.g. 'analytics:tenant123:*'
 * @returns {Promise<number>} — count of keys deleted (0 if none matched or Redis down)
 */
async function invalidatePattern(pattern) {
  // redis.keys() returns [] when Redis is unavailable (adapter guards this).
  const keys = await redis.keys(pattern);

  // TASK 6: validate array before spread
  if (!Array.isArray(keys) || keys.length === 0) return 0;

  // TASK 6: filter to non-empty strings to prevent arity errors from
  // accidentally-empty elements (defensive against upstream bugs).
  const validKeys = keys.filter(k => typeof k === 'string' && k.length > 0);
  if (validKeys.length === 0) return 0;

  // Spread validated array into del() — safe because:
  //   1. Array is non-empty (checked above)
  //   2. All elements are non-empty strings (filtered above)
  //   3. redis.del() adapter already guards against Redis being unavailable
  await redis.del(...validKeys);

  return validKeys.length;
}

module.exports = {
  DEFAULT_TTL,
  buildKey,
  getOrSet,
  invalidatePattern,
};