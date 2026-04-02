'use strict';

/**
 * src/modules/dashboard/dashboardCache.js
 *
 * Thin lazy proxy for dashboard cache invalidation.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Resume, profile, and CHI handlers need dashboard cache invalidation
 * without importing dashboard.service directly, which may create
 * circular dependency chains.
 *
 * This module provides a lazy boundary so dashboard.service is resolved
 * only when invalidation is actually called.
 *
 * Cache invalidation is intentionally non-blocking at call sites.
 * If Redis is unavailable, the service degrades gracefully and the
 * cache expires naturally via TTL.
 */

/**
 * invalidateDashboardCache(userId)
 *
 * Lazy-loads dashboard.service only at execution time,
 * preventing eager circular dependency resolution.
 *
 * @param {string} userId
 * @returns {Promise<void>}
 */
async function invalidateDashboardCache(userId) {
  const {
    invalidateDashboardCache: invalidate,
  } = require('./dashboard.service');

  return invalidate(userId);
}

module.exports = {
  invalidateDashboardCache,
};