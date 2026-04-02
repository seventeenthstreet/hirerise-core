'use strict';

/**
 * requireMasterAdmin.middleware.js (Production Optimized)
 */

const crypto = require('crypto');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const MASTER_ADMIN_ROLE = 'MASTER_ADMIN';

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function getRequestId(req) {
  return (
    req.correlationId || // ✅ align with global tracing
    req.headers['x-correlation-id'] ||
    req.headers['x-request-id'] ||
    crypto.randomUUID()
  );
}

function normalizeRoles(roles) {
  if (!Array.isArray(roles)) return [];
  return roles.filter(r => typeof r === 'string');
}

function isMasterAdmin(user) {
  const role = typeof user.role === 'string' ? user.role : '';
  const roles = normalizeRoles(user.roles);

  return role === MASTER_ADMIN_ROLE || roles.includes(MASTER_ADMIN_ROLE);
}

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────

const requireMasterAdmin = (req, res, next) => {
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

  const allowed = isMasterAdmin(user);

  // ── Access check ───────────────────────────────────────
  if (!allowed) {
    logger.warn('[RequireMasterAdmin] Access denied', {
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
        message: 'MASTER_ADMIN privileges required.',
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

module.exports = { requireMasterAdmin };