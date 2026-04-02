'use strict';

/**
 * verifyAdmin.middleware.js (Production Optimized)
 */

const crypto = require('crypto');
const logger = require('../utils/logger');

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

function hasAdminAccess(user) {
  const role = typeof user.role === 'string' ? user.role : '';
  const roles = normalizeRoles(user.roles);

  return (
    user.admin === true ||
    ['admin', 'super_admin'].includes(role) ||
    roles.includes('admin') ||
    roles.includes('super_admin')
  );
}

function isSuperAdmin(user) {
  const role = typeof user.role === 'string' ? user.role : '';
  const roles = normalizeRoles(user.roles);

  return role === 'super_admin' || roles.includes('super_admin');
}

// ─────────────────────────────────────────────────────────────────────────────
// verifyAdmin
// ─────────────────────────────────────────────────────────────────────────────

function verifyAdmin(req, res, next) {
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

  const allowed = hasAdminAccess(user);

  if (!allowed) {
    logger.warn('[verifyAdmin] Access denied', {
      requestId,
      correlationId: req.correlationId,
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
        message: 'Admin privileges required.',
      },
      requestId,
      timestamp: new Date().toISOString(),
    });
  }

  return next();
}

// ─────────────────────────────────────────────────────────────────────────────
// verifySuperAdmin
// ─────────────────────────────────────────────────────────────────────────────

function verifySuperAdmin(req, res, next) {
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

  const allowed = isSuperAdmin(user);

  if (!allowed) {
    logger.warn('[verifySuperAdmin] Access denied', {
      requestId,
      correlationId: req.correlationId,
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
        message: 'Super admin privileges required.',
      },
      requestId,
      timestamp: new Date().toISOString(),
    });
  }

  return next();
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  verifyAdmin,
  verifySuperAdmin,
};