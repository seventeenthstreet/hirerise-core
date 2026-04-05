'use strict';

/**
 * src/routes/admin/adminAuth.routes.js
 *
 * Admin Session Management (Supabase-ready)
 *
 * Mount in server.js:
 *   app.use(
 *     `${API_PREFIX}/admin/auth`,
 *     authenticate,
 *     require('./routes/admin/adminAuth.routes')
 *   );
 *
 * Endpoints:
 *   POST /session      → refresh admin session
 *   GET  /me           → get current admin principal info
 *   POST /grant        → MASTER_ADMIN grants admin access
 *   POST /revoke       → MASTER_ADMIN revokes admin access
 *   GET  /principals   → list all active admin principals
 *
 * Notes:
 * - Session refresh should be called on every admin dashboard load
 * - Repository layer handles Supabase persistence and upsert logic
 * - No Firebase/Firestore dependencies remain
 */

const express = require('express');
const { body } = require('express-validator');

const { validate } = require('../../middleware/requestValidator');
const { requireAdmin } = require('../../middleware/auth.middleware');
const { asyncHandler } = require('../../utils/helpers');
const adminPrincipalRepo = require('../../modules/admin/repository/adminPrincipal.repository');
const logger = require('../../utils/logger');

const router = express.Router();

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const ALLOWED_ADMIN_ROLES = Object.freeze([
  'admin',
  'super_admin',
  'MASTER_ADMIN',
]);

/**
 * Resolve authenticated user identifier safely.
 * Keeps backward compatibility with existing auth middleware
 * while supporting Supabase-standard `id`.
 */
function getAuthenticatedUserId(req) {
  return req.user?.uid ?? req.user?.id ?? null;
}

/**
 * Check whether current user is MASTER_ADMIN.
 */
function isMasterAdmin(req) {
  const role = req.user?.role;
  const roles = Array.isArray(req.user?.roles) ? req.user.roles : [];

  return role === 'MASTER_ADMIN' || roles.includes('MASTER_ADMIN');
}

/**
 * Standard unauthenticated response.
 */
function unauthenticated(res) {
  return res.status(401).json({
    success: false,
    message: 'Unauthenticated',
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /session — refresh admin session
// Auto-provisions principal row if missing
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/session',
  asyncHandler(async (req, res) => {
    const userId = getAuthenticatedUserId(req);

    if (!userId) {
      return unauthenticated(res);
    }

    await adminPrincipalRepo.refreshSession(userId);

    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

    logger.info('[AdminAuth] Session refreshed', {
      userId,
      route: '/admin/auth/session',
    });

    return res.json({
      success: true,
      message: 'Admin session refreshed',
      uid: userId, // preserve API response compatibility
      expiresAt,
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /me — current principal info
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/me',
  asyncHandler(async (req, res) => {
    const userId = getAuthenticatedUserId(req);

    if (!userId) {
      return unauthenticated(res);
    }

    const principal = await adminPrincipalRepo.verify(userId);

    return res.json({
      success: true,
      data: principal,
      sessionValid: Boolean(principal),
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /grant — MASTER_ADMIN grants admin access
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/grant',
  requireAdmin,
  validate([
    body('uid')
      .isString()
      .trim()
      .notEmpty()
      .withMessage('uid is required'),

    body('role')
      .isIn(ALLOWED_ADMIN_ROLES)
      .withMessage(
        `role must be one of: ${ALLOWED_ADMIN_ROLES.join(', ')}`
      ),
  ]),
  asyncHandler(async (req, res) => {
    const actorId = getAuthenticatedUserId(req);

    if (!actorId) {
      return unauthenticated(res);
    }

    if (!isMasterAdmin(req)) {
      return res.status(403).json({
        success: false,
        message: 'Only MASTER_ADMIN can grant admin access.',
      });
    }

    const { uid, role } = req.body;

    await adminPrincipalRepo.grant(uid, role, actorId);

    logger.info('[AdminAuth] Access granted', {
      targetUserId: uid,
      role,
      grantedBy: actorId,
    });

    return res.json({
      success: true,
      message: `Admin access granted to ${uid} with role ${role}`,
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /revoke — MASTER_ADMIN revokes admin access
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/revoke',
  requireAdmin,
  validate([
    body('uid')
      .isString()
      .trim()
      .notEmpty()
      .withMessage('uid is required'),
  ]),
  asyncHandler(async (req, res) => {
    const actorId = getAuthenticatedUserId(req);

    if (!actorId) {
      return unauthenticated(res);
    }

    if (!isMasterAdmin(req)) {
      return res.status(403).json({
        success: false,
        message: 'Only MASTER_ADMIN can revoke admin access.',
      });
    }

    const targetUid = req.body.uid;

    if (targetUid === actorId) {
      return res.status(400).json({
        success: false,
        message: 'Cannot revoke your own access.',
      });
    }

    await adminPrincipalRepo.revoke(targetUid, actorId);

    logger.info('[AdminAuth] Access revoked', {
      targetUserId: targetUid,
      revokedBy: actorId,
    });

    return res.json({
      success: true,
      message: `Admin access revoked for ${targetUid}`,
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /principals — list active principals
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/principals',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const actorId = getAuthenticatedUserId(req);

    if (!actorId) {
      return unauthenticated(res);
    }

    if (!isMasterAdmin(req)) {
      return res.status(403).json({
        success: false,
        message: 'Only MASTER_ADMIN can list principals.',
      });
    }

    const principals = await adminPrincipalRepo.listActive();

    return res.json({
      success: true,
      data: {
        principals,
        total: principals.length,
      },
    });
  })
);

module.exports = router;