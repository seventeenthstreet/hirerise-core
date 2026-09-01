'use strict';

/**
 * requireEditor.middleware.js — WP-ADMIN-04G
 *
 * Mirrors requireContributor.middleware.js's shape exactly, gating on the
 * `editor` role instead of `contributor`. Administrator roles (admin,
 * super_admin, MASTER_ADMIN) are granted access here for the same reason
 * requireContributor.js grants it to them: broader Administrator authority
 * already implies narrower ordinary-role capabilities. `contributor` does
 * NOT pass this gate — Editor authority is a distinct ordinary role, not a
 * superset/subset relationship with Contributor (see the WP-ADMIN-04G
 * target role model: Editor may edit Contributor-created content, but that
 * is an application-level capability, not a role-hierarchy grant).
 */

const crypto = require('crypto');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_ROLES = new Set([
  'editor',
  'admin',
  'super_admin',
  'MASTER_ADMIN',
]);

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function getRequestId(req) {
  return (
    req.correlationId ||
    req.headers['x-correlation-id'] ||
    req.headers['x-request-id'] ||
    crypto.randomUUID()
  );
}

function normalizeRoles(roles) {
  if (!Array.isArray(roles)) return [];
  return roles.filter(r => typeof r === 'string');
}

function hasEditorAccess(user) {
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

const requireEditor = (req, res, next) => {
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

  const allowed = hasEditorAccess(user);

  // ── Access check ───────────────────────────────────────
  if (!allowed) {
    logger.warn('[RequireEditor] Access denied', {
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
        message: 'Editor or admin privileges required.',
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

module.exports = { requireEditor };
