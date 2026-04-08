'use strict';

const NodeCache = require('node-cache');
const logger = require('./logger');

const DEFAULT_TTL_SECONDS = 600; // 10 minutes
const CHECK_PERIOD_SECONDS = 120; // 2 minutes

/**
 * Shared in-memory cache singleton.
 *
 * Designed for:
 * - Supabase read-through caching
 * - dictionary lookups
 * - expensive RPC memoization
 * - temporary API aggregation caching
 *
 * Notes:
 * - process-local only
 * - not shared across instances
 * - safe for stateless horizontal scaling
 */
const cache = new NodeCache({
  stdTTL: DEFAULT_TTL_SECONDS,
  checkperiod: CHECK_PERIOD_SECONDS,
  useClones: false,
  deleteOnExpire: true,
  maxKeys: 5000,
});

// ─────────────────────────────────────────────
// Optional lightweight observability
// ─────────────────────────────────────────────

cache.on('expired', (key) => {
  logger.debug?.('[Cache] Key expired', { key });
});

cache.on('flush', () => {
  logger.info?.('[Cache] Cache flushed');
});

// ─────────────────────────────────────────────
// Safe helpers
// ─────────────────────────────────────────────

/**
 * Get cached value safely.
 *
 * @template T
 * @param {string} key
 * @returns {T | undefined}
 */
function get(key) {
  if (!key) return undefined;
  return cache.get(key);
}

/**
 * Set cached value safely.
 *
 * @template T
 * @param {string} key
 * @param {T} value
 * @param {number} [ttl]
 * @returns {boolean}
 */
function set(key, value, ttl = DEFAULT_TTL_SECONDS) {
  if (!key) return false;
  return cache.set(key, value, ttl);
}

/**
 * Delete a cache key.
 *
 * @param {string} key
 * @returns {number}
 */
function del(key) {
  if (!key) return 0;
  return cache.del(key);
}

/**
 * Clear all cache entries.
 */
function flush() {
  cache.flushAll();
}

/**
 * Cache stats for monitoring.
 *
 * @returns {import('node-cache').Stats}
 */
function stats() {
  return cache.getStats();
}

module.exports = {
  cache,
  get,
  set,
  del,
  flush,
  stats,
};