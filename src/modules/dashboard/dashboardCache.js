'use strict';

/**
 * dashboardCache.js
 *
 * Thin re-export of invalidateDashboardCache from dashboard.service.js.
 *
 * WHY:
 *   Resume upload, profile update, and CHI recalculation handlers need to
 *   invalidate the dashboard Redis snapshot. Importing directly from
 *   dashboard.service.js would create circular dependency chains if those
 *   modules are also imported by dashboard.service.js.
 *
 *   This lightweight module breaks the potential cycle — handlers import
 *   this file, not dashboard.service.js directly.
 *
 * USAGE in any handler / service / controller:
 *
 *   const { invalidateDashboardCache } = require('../../modules/dashboard/dashboardCache');
 *
 *   // After resume upload:
 *   await invalidateDashboardCache(userId).catch(() => {});  // non-fatal
 *
 *   // After profile update:
 *   await invalidateDashboardCache(userId).catch(() => {});
 *
 *   // After CHI recalculation completes:
 *   await invalidateDashboardCache(userId).catch(() => {});
 *
 * The .catch(() => {}) is intentional — cache invalidation is never a
 * blocking dependency. If Redis is down, the cache key will expire
 * naturally after 120–150 seconds.
 */

const { invalidateDashboardCache } = require('./dashboard.service');

module.exports = { invalidateDashboardCache };








