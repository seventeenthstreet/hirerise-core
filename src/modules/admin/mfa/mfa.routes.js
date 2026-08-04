'use strict';

/**
 * src/modules/admin/mfa/mfa.routes.js
 *
 * WP-ADMIN-02C — Enterprise Admin Step-Up Authentication (TOTP)
 *
 * Mounted in server.js at the specific sub-path /api/v1/admin/mfa (NOT the
 * bare API_PREFIX — see the WP-ADMIN-03 rate-limiter incident earlier in
 * this program for why a bare-prefix mount is the wrong pattern).
 *
 * Gated by `authenticate` + an admin-role check only (isAdminRole below,
 * reusing the same role list as requireAdmin.middleware.js) — NOT by
 * requireElevatedSession, since these are the routes that CREATE the
 * elevated session in the first place. requireAdmin's full DB-verification
 * path is intentionally not used here either, to avoid a chicken-and-egg
 * dependency on admin_principals during enrollment.
 */

const express = require('express');
const router = express.Router();

const mfaService = require('./mfa.service');
const logger = require('../../../utils/logger');

const ADMIN_ROLES = new Set(['MASTER_ADMIN', 'admin', 'super_admin']);

function isAdminRole(req, res, next) {
  const role = req.user?.role;
  if (!role || !ADMIN_ROLES.has(role)) {
    return res.status(403).json({ success: false, error: 'Admin role required.' });
  }
  next();
}

function handle(fn) {
  return async (req, res) => {
    try {
      const result = await fn(req, res);
      res.json({ success: true, ...result });
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) {
        logger.error('[MFA] Route error', { path: req.path, error: err.message });
      }
      res.status(status).json({ success: false, error: err.message || 'MFA request failed.' });
    }
  };
}

// GET /api/v1/admin/mfa/status
router.get('/status', isAdminRole, handle(async (req) => {
  const status = await mfaService.getStatus(req.user.id);
  return { status };
}));

// POST /api/v1/admin/mfa/enroll
router.post('/enroll', isAdminRole, handle(async (req) => {
  const enrollment = await mfaService.beginEnrollment(req.user.id, req.user.email);
  return { enrollment };
}));

// POST /api/v1/admin/mfa/verify  { code }
router.post('/verify', isAdminRole, handle(async (req) => {
  const { code } = req.body || {};
  if (!code) {
    throw Object.assign(new Error('code is required.'), { status: 400 });
  }
  const result = await mfaService.verifyEnrollment(req.user.id, code, req.ip);
  return result;
}));

// POST /api/v1/admin/mfa/challenge  { code }
router.post('/challenge', isAdminRole, handle(async (req) => {
  const { code } = req.body || {};
  if (!code) {
    throw Object.assign(new Error('code is required.'), { status: 400 });
  }
  const result = await mfaService.challenge(req.user.id, code, req.ip);
  return result;
}));

// POST /api/v1/admin/mfa/recovery  { code }
router.post('/recovery', isAdminRole, handle(async (req) => {
  const { code } = req.body || {};
  if (!code) {
    throw Object.assign(new Error('code is required.'), { status: 400 });
  }
  const result = await mfaService.useRecoveryCode(req.user.id, code, req.ip);
  return result;
}));

module.exports = router;
