'use strict';

/**
 * requireContributor.middleware.js (Production Optimized)
 */

const crypto = require('crypto');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_ROLES = new Set([
  'contributor',
  'admin',
  'super_admin',
  'MASTER_ADMIN',
]);

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function getRequestId(req) {
  return (
    req.correlationId || // ✅ use global correlation ID
    req.headers['x-correlation-id'] ||
    req.headers['x-request-id'] ||
    crypto.randomUUID()
  );
}

function normalizeRoles(roles) {
  if (!Array.isArray(roles)) return [];
  return roles.filter(r => typeof r === 'string');
}

function hasContributorAccess(user) {
  const role = typeof user.role === 'string' ? user.role : '';
  const roles = normalizeRoles(user.roles);

  return (
    user.admin === true ||
    ALLOWED_ROLES.has(role) ||
    roles.some(r => ALLOWED_ROLES.has(r))
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────

const requireContributor = (req, res, next) => {
  const requestId = getRequestId(req);
  const user = req.user;

  // ── Auth check ─────────────────────────────────────────
  if (!user) {
    return res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authentication required.',
      },
      requestId,
      timestamp: new Date().toISOString(),
    });
  }

  const allowed = hasContributorAccess(user);

  // ── Access check ───────────────────────────────────────
  if (!allowed) {
    logger.warn('[RequireContributor] Access denied', {
      requestId,
      correlationId: req.correlationId, // ✅ observability
      userId: user.uid,
      role: user.role,
      roles: user.roles,
      path: req.originalUrl,
      method: req.method,
      ip: req.ip,
    });

    return res.status(403).json({
      success: false,
      error: {
        code: 'FORBIDDEN',
        message: 'Contributor or admin privileges required.',
      },
      requestId,
      timestamp: new Date().toISOString(),
    });
  }

  return next();
};

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────────────────────────────────────

module.exports = { requireContributor };