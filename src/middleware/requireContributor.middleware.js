'use strict';

/**
 * requireContributor.middleware.js
 *
 * Allows access to users with role: 'contributor', 'admin', 'super_admin',
 * or 'MASTER_ADMIN'. Blocks regular 'user' accounts.
 *
 * Contributors can submit entries for review but cannot publish or delete.
 * Admins and above can do everything contributors can, plus approve/reject.
 *
 * Usage:
 *   router.post('/pending', authenticate, requireContributor, handler);
 */

const logger = require('../utils/logger');

const ALLOWED_ROLES = new Set(['contributor', 'admin', 'super_admin', 'MASTER_ADMIN']);

const requireContributor = (req, res, next) => {
  const user = req.user;

  if (!user) {
    return res.status(401).json({
      success: false, errorCode: 'UNAUTHORIZED',
      message: 'Authentication required.',
      timestamp: new Date().toISOString(),
    });
  }

  const role = user.role ?? '';
  const roles = user.roles ?? [];
  const hasAccess =
    user.admin === true ||
    ALLOWED_ROLES.has(role) ||
    roles.some(r => ALLOWED_ROLES.has(r));

  if (!hasAccess) {
    logger.warn('[Auth] Contributor access denied', { uid: user.uid, role, path: req.originalUrl });
    return res.status(403).json({
      success: false, errorCode: 'FORBIDDEN',
      message: 'Contributor or admin privileges required.',
      timestamp: new Date().toISOString(),
    });
  }

  next();
};

module.exports = { requireContributor };








