'use strict';

/**
 * src/middleware/adminRoleClaim.middleware.js
 *
 * WP-ADMIN-03D: extracted from the identical duplicated `requireAdminRole`
 * implementations previously defined locally in:
 *   - src/routes/admin/xaiMetrics.routes.js
 *   - src/routes/admin/systemHealth.routes.js
 *
 * Logic is unchanged byte-for-byte from the original duplicated functions —
 * this is a pure deduplication, not a behavior change. It checks a JWT role
 * claim only (no DB round-trip), which is a distinct, lighter-weight check
 * than the DB-verified src/middleware/requireAdmin.middleware.js used
 * elsewhere in the app. See WP-ADMIN-03D certification report for why the
 * DB-verified middleware was not substituted here.
 */

const requireAdminRole = (req, res, next) => {
  const role = req.user?.role || req.user?.customClaims?.role;
  if (!['admin', 'super_admin'].includes(role)) {
    return res.status(403).json({ error: 'Forbidden', code: 'ADMIN_REQUIRED' });
  }
  next();
};

module.exports = { requireAdminRole };
