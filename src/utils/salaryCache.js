'use strict';

/**
 * salaryCache.js — In-Memory Cache for Salary Aggregation Results
 *
 * Uses node-cache (already in package.json).
 *
 * Cache key format:  salary:<roleId>:<filtersJSON>
 * TTL:               SALARY_CACHE_TTL_SECONDS env var (default: 300s = 5 min)
 *
 * Usage:
 *   const { getCachedSalary, setCachedSalary, invalidateSalaryCache } = require('../../utils/salaryCache');
 *
 *   // Read
 *   const cached = getCachedSalary(roleId, filters);
 *   if (cached) return cached;
 *
 *   // Write
 *   setCachedSalary(roleId, filters, result);
 *
 *   // Invalidate (call after new salary_data record inserted)
 *   invalidateSalaryCache(roleId);
 *
 * @module utils/salaryCache
 */

const NodeCache = require('node-cache');
const logger    = require('./logger');

const TTL_SECONDS = parseInt(process.env.SALARY_CACHE_TTL_SECONDS || '300', 10);

// Single shared cache instance for the process lifetime
const cache = new NodeCache({
  stdTTL:      TTL_SECONDS,
  checkperiod: Math.max(60, Math.floor(TTL_SECONDS / 2)), // GC sweep interval
  useClones:   false, // avoid deep-clone overhead for read-heavy workload
});

/**
 * Build a deterministic cache key from roleId + filters.
 *
 * @param {string} roleId
 * @param {object} filters
 * @returns {string}
 */
function buildCacheKey(roleId, filters = {}) {
  // Sort keys so { location: 'India', experienceLevel: 'Mid' }
  // and { experienceLevel: 'Mid', location: 'India' } produce the same key
  const sortedFilters = Object.keys(filters)
    .sort()
    .reduce((acc, k) => { acc[k] = filters[k]; return acc; }, {});

  return `salary:${roleId}:${JSON.stringify(sortedFilters)}`;
}

/**
 * Get a cached aggregation result.
 *
 * @param {string} roleId
 * @param {object} filters
 * @returns {object|null} cached result or null on miss
 */
function getCachedSalary(roleId, filters = {}) {
  const key    = buildCacheKey(roleId, filters);
  const cached = cache.get(key);

  if (cached !== undefined) {
    logger.debug('[SalaryCache] Cache hit', { key });
    return cached;
  }

  logger.debug('[SalaryCache] Cache miss', { key });
  return null;
}

/**
 * Store an aggregation result in cache.
 *
 * @param {string} roleId
 * @param {object} filters
 * @param {object} result
 */
function setCachedSalary(roleId, filters = {}, result) {
  const key = buildCacheKey(roleId, filters);
  cache.set(key, result);
  logger.debug('[SalaryCache] Cache set', { key, ttl: TTL_SECONDS });
}

/**
 * Invalidate all cached results for a roleId.
 * Call this whenever a new salary_data record is inserted for that role.
 *
 * @param {string} roleId
 */
function invalidateSalaryCache(roleId) {
  const keys       = cache.keys();
  const prefix     = `salary:${roleId}:`;
  const toDelete   = keys.filter(k => k.startsWith(prefix));

  if (toDelete.length > 0) {
    cache.del(toDelete);
    logger.info('[SalaryCache] Cache invalidated', { roleId, keysDeleted: toDelete.length });
  }
}

/**
 * Get current cache stats (for health checks / admin dashboards).
 * @returns {{ keys: number, hits: number, misses: number, ttl: number }}
 */
function getCacheStats() {
  const stats = cache.getStats();
  return {
    keys:   cache.keys().length,
    hits:   stats.hits,
    misses: stats.misses,
    ttl:    TTL_SECONDS,
  };
}

module.exports = {
  getCachedSalary,
  setCachedSalary,
  invalidateSalaryCache,
  getCacheStats,
};








