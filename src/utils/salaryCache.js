'use strict';

/**
 * salaryCache.js — In-Memory Cache for Salary Aggregation Results
 *
 * Optimized for:
 * - Supabase salary RPC caching
 * - role-based compensation analytics
 * - market salary filters
 * - read-heavy dashboards
 */

const NodeCache = require('node-cache');
const logger = require('./logger');

const DEFAULT_TTL_SECONDS = 300;
const MAX_KEYS = 10000;

const parsedTtl = Number.parseInt(
  process.env.SALARY_CACHE_TTL_SECONDS || `${DEFAULT_TTL_SECONDS}`,
  10
);

const TTL_SECONDS =
  Number.isFinite(parsedTtl) && parsedTtl > 0
    ? parsedTtl
    : DEFAULT_TTL_SECONDS;

const cache = new NodeCache({
  stdTTL: TTL_SECONDS,
  checkperiod: Math.max(60, Math.floor(TTL_SECONDS / 2)),
  useClones: false,
  deleteOnExpire: true,
  maxKeys: MAX_KEYS,
});

// Secondary index for fast role-based invalidation
const roleKeyIndex = new Map();

/**
 * Stable deterministic stringify for nested filters.
 *
 * @param {unknown} value
 * @returns {string}
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  const sortedKeys = Object.keys(value).sort();

  return `{${sortedKeys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}

/**
 * Build deterministic cache key.
 *
 * @param {string} roleId
 * @param {object} filters
 * @returns {string}
 */
function buildCacheKey(roleId, filters = {}) {
  return `salary:v1:${roleId}:${stableStringify(filters)}`;
}

/**
 * Register key in secondary invalidation index.
 *
 * @param {string} roleId
 * @param {string} key
 */
function trackRoleKey(roleId, key) {
  if (!roleKeyIndex.has(roleId)) {
    roleKeyIndex.set(roleId, new Set());
  }

  roleKeyIndex.get(roleId).add(key);
}

/**
 * Get cached salary result.
 *
 * @param {string} roleId
 * @param {object} filters
 * @returns {object|null}
 */
function getCachedSalary(roleId, filters = {}) {
  if (!roleId) return null;

  const key = buildCacheKey(roleId, filters);
  const cached = cache.get(key);

  if (cached !== undefined) {
    logger.debug('[SalaryCache] Cache hit', { role_id: roleId });
    return cached;
  }

  logger.debug('[SalaryCache] Cache miss', { role_id: roleId });
  return null;
}

/**
 * Set cached salary result.
 *
 * @param {string} roleId
 * @param {object} filters
 * @param {object} result
 * @param {number} [ttl]
 */
function setCachedSalary(
  roleId,
  filters = {},
  result,
  ttl = TTL_SECONDS
) {
  if (!roleId || result == null) {
    return;
  }

  const key = buildCacheKey(roleId, filters);

  cache.set(key, result, ttl);
  trackRoleKey(roleId, key);

  logger.debug('[SalaryCache] Cache set', {
    role_id: roleId,
    ttl,
  });
}

/**
 * Fast role-scoped invalidation.
 *
 * @param {string} roleId
 */
function invalidateSalaryCache(roleId) {
  if (!roleId) return;

  const keys = roleKeyIndex.get(roleId);

  if (!keys || keys.size === 0) {
    return;
  }

  const deleted = cache.del([...keys]);
  roleKeyIndex.delete(roleId);

  logger.info('[SalaryCache] Cache invalidated', {
    role_id: roleId,
    keys_deleted: deleted,
  });
}

/**
 * Cache health stats.
 *
 * @returns {{
 *   keys: number,
 *   hits: number,
 *   misses: number,
 *   ttl: number,
 *   max_keys: number
 * }}
 */
function getCacheStats() {
  const stats = cache.getStats();

  return {
    keys: cache.keys().length,
    hits: stats.hits,
    misses: stats.misses,
    ttl: TTL_SECONDS,
    max_keys: MAX_KEYS,
  };
}

module.exports = {
  getCachedSalary,
  setCachedSalary,
  invalidateSalaryCache,
  getCacheStats,
};