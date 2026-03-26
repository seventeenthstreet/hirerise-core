'use strict';

/**
 * requireMasterAdmin.middleware.js — MASTER_ADMIN Role Guard
 *
 * Only users with role === 'MASTER_ADMIN' (exact, case-sensitive) may pass.
 * Regular ADMIN, DATA_MANAGER, ANALYST are all rejected with HTTP 403.
 *
 * Usage in server.js:
 *   const { requireMasterAdmin } = require('./middleware/requireMasterAdmin.middleware');
 *   app.use(`${API_PREFIX}/master/apis`, authenticate, requireMasterAdmin, masterRoutes);
 *
 * To grant MASTER_ADMIN to a user (run once from admin script):
 *   await getAuth().setCustomUserClaims(uid, { role: 'MASTER_ADMIN' });
 *
 * JWT token must include:
 *   { userId, role: 'MASTER_ADMIN' }
 *
 * Supported roles hierarchy:
 *   MASTER_ADMIN  → can access /master/* AND /admin/*
 *   ADMIN         → can access /admin/* only
 *   DATA_MANAGER  → limited admin access (future)
 *   ANALYST       → read-only analytics (future)
 */

const logger = require('../utils/logger');

const MASTER_ADMIN_ROLE = 'MASTER_ADMIN';

/**
 * requireMasterAdmin
 *
 * Must be used AFTER authenticate middleware.
 * authenticate populates req.user from the verified auth token.
 *
 * @type {import('express').RequestHandler}
 */
const requireMasterAdmin = (req, res, next) => {
  const user = req.user;

  if (!user) {
    return res.status(401).json({
      success:   false,
      errorCode: 'UNAUTHORIZED',
      message:   'Authentication required.',
      timestamp: new Date().toISOString(),
    });
  }

  const isMasterAdmin =
    user.role === MASTER_ADMIN_ROLE ||
    (user.roles ?? []).includes(MASTER_ADMIN_ROLE);

  if (!isMasterAdmin) {
    logger.warn('[Auth] Unauthorized MASTER_ADMIN access attempt', {
      uid:        user.uid,
      role:       user.role,
      path:       req.originalUrl,
      ip:         req.ip,
    });

    return res.status(403).json({
      success:   false,
      errorCode: 'FORBIDDEN',
      message:   'MASTER_ADMIN privileges required.',
      timestamp: new Date().toISOString(),
    });
  }

  next();
};

module.exports = { requireMasterAdmin };








