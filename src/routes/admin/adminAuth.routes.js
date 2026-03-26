'use strict';

/**
 * adminAuth.routes.js — Admin Session Management
 *
 * Mount in server.js:
 *   app.use(`${API_PREFIX}/admin/auth`, authenticate, require('./routes/admin/adminAuth.routes'));
 *
 * Endpoints:
 *   POST /admin/auth/session   → refresh admin session (call on every dashboard load)
 *   GET  /admin/auth/me        → get current admin principal info
 *   POST /admin/auth/grant     → MASTER_ADMIN grants admin access to a user
 *   POST /admin/auth/revoke    → MASTER_ADMIN revokes admin access
 *   GET  /admin/auth/principals → list all active admin principals
 *
 * This solves the "principal not found or session expired" 403 error.
 * Call POST /admin/auth/session on every admin dashboard load.
 * refreshSession() auto-provisions the Supabase record if it doesn't exist.
 */

const express = require('express');
const { body, param } = require('express-validator');
const { validate }    = require('../../middleware/requestValidator');
const { requireAdmin } = require('../../middleware/auth.middleware');
const { asyncHandler } = require('../../utils/helpers');
const adminPrincipalRepo = require('../../modules/admin/repository/adminPrincipal.repository');
const logger = require('../../utils/logger');

const router = express.Router();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function isMasterAdmin(req) {
  return req.user?.role === 'MASTER_ADMIN' ||
    (req.user?.roles ?? []).includes('MASTER_ADMIN');
}

// ── POST /session — refresh session (call on every admin page load) ───────────
// This auto-provisions the admin_principals record if it doesn't exist yet,
// which fixes the "principal not found or session expired" 403 error.
router.post('/session',
  asyncHandler(async (req, res) => {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ success: false, message: 'Unauthenticated' });

    await adminPrincipalRepo.refreshSession(uid);

    logger.info('[AdminAuth] Session refreshed', { uid });
    return res.json({
      success:   true,
      message:   'Admin session refreshed',
      uid,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    });
  })
);

// ── GET /me — current principal info ─────────────────────────────────────────
router.get('/me',
  asyncHandler(async (req, res) => {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ success: false });

    const principal = await adminPrincipalRepo.verify(uid);
    return res.json({
      success:      true,
      data:         principal,
      sessionValid: !!principal,
    });
  })
);

// ── POST /grant — MASTER_ADMIN grants admin access ────────────────────────────
router.post('/grant',
  requireAdmin,
  validate([
    body('uid').isString().trim().notEmpty().withMessage('uid is required'),
    body('role').isIn(['admin', 'super_admin', 'MASTER_ADMIN'])
      .withMessage('role must be admin, super_admin, or MASTER_ADMIN'),
  ]),
  asyncHandler(async (req, res) => {
    if (!isMasterAdmin(req)) {
      return res.status(403).json({ success: false, message: 'Only MASTER_ADMIN can grant admin access.' });
    }

    const { uid, role } = req.body;
    await adminPrincipalRepo.grant(uid, role, req.user.uid);

    logger.info('[AdminAuth] Access granted', { uid, role, grantedBy: req.user.uid });
    return res.json({ success: true, message: `Admin access granted to ${uid} with role ${role}` });
  })
);

// ── POST /revoke — MASTER_ADMIN revokes admin access ─────────────────────────
router.post('/revoke',
  requireAdmin,
  validate([body('uid').isString().trim().notEmpty().withMessage('uid is required')]),
  asyncHandler(async (req, res) => {
    if (!isMasterAdmin(req)) {
      return res.status(403).json({ success: false, message: 'Only MASTER_ADMIN can revoke admin access.' });
    }
    if (req.body.uid === req.user.uid) {
      return res.status(400).json({ success: false, message: 'Cannot revoke your own access.' });
    }

    await adminPrincipalRepo.revoke(req.body.uid, req.user.uid);
    return res.json({ success: true, message: `Admin access revoked for ${req.body.uid}` });
  })
);

// ── GET /principals — list active principals ──────────────────────────────────
router.get('/principals',
  requireAdmin,
  asyncHandler(async (req, res) => {
    if (!isMasterAdmin(req)) {
      return res.status(403).json({ success: false, message: 'Only MASTER_ADMIN can list principals.' });
    }
    const principals = await adminPrincipalRepo.listActive();
    return res.json({ success: true, data: { principals, total: principals.length } });
  })
);

module.exports = router;








