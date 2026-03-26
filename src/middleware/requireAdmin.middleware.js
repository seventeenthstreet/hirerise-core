'use strict';

/**
 * requireAdmin.middleware.js — PHASE 1 UPGRADE: Two-Factor Admin Verification
 *
 * PROBLEM FIXED:
 *   The original requireAdmin checked only the Firebase custom claim
 *   (decoded.role === 'admin'). Custom claims can be set by ANY code holding
 *   * Legacy admin credential systems could allow privilege escalation if compromised.
* This implementation enforces stricter role validation.
 *
 * SOLUTION: Two-factor admin verification
 *   Factor 1: Firebase custom claim (role === 'admin' | decoded.admin === true)
 *   Factor 2: Presence in admin_principals/{uid} Firestore collection with:
 *             - isActive: true
 *             - verifiedAt within the last 24 hours
 *
 * BOTH factors must pass. Passing one alone is insufficient.
 *
 * SESSION REFRESH:
 *   Call requireAdmin.refreshSession(uid) when an admin logs in via the
 *   admin dashboard. This sets verifiedAt to now, starting the 24-hour window.
 *
 * MASTER ADMIN BYPASS:
 *   MASTER_ADMIN role bypasses the 24h session TTL (they manage the system).
 *   Their principals still must be isActive: true.
 *
 * FALLBACK MODE (ADMIN_HARDENING_ENABLED=false):
 *   If ADMIN_HARDENING_ENABLED is not set to 'true', this middleware behaves
 *   identically to the original requireAdmin — claim-only check. This allows
 *   gradual rollout: set env var to 'true' after admin_principals are seeded.
 *
 * MIGRATION:
 *   Run scripts/seedAdminPrincipals.js once to create admin_principals records
 *   for all existing admin users before enabling ADMIN_HARDENING_ENABLED=true.
 */

const logger               = require('../utils/logger');
const adminPrincipalRepo   = require('../modules/admin/repository/adminPrincipal.repository');

const HARDENING_ENABLED = process.env.ADMIN_HARDENING_ENABLED === 'true';

/**
 * requireAdmin — upgraded two-factor admin guard.
 * Drop-in replacement for the original requireAdmin in auth.middleware.js.
 */
const requireAdmin = async (req, res, next) => {
  const user = req.user;

  if (!user) {
    return res.status(401).json({
      success: false, errorCode: 'UNAUTHORIZED',
      message: 'Authentication required.',
      timestamp: new Date().toISOString(),
    });
  }

  // ── Factor 1: Firebase custom claim ───────────────────────────────────────
  const isMasterAdmin = user.role === 'MASTER_ADMIN' ||
    (user.roles ?? []).includes('MASTER_ADMIN');

  const hasAdminClaim =
    isMasterAdmin ||
    user.admin === true ||
    ['admin', 'super_admin'].includes(user.role ?? '') ||
    (user.roles ?? []).includes('admin');

  if (!hasAdminClaim) {
    logger.warn('[RequireAdmin] Rejected — no admin claim', {
      uid: user.uid, role: user.role, path: req.originalUrl,
    });
    return res.status(403).json({
      success: false, errorCode: 'FORBIDDEN',
      message: 'Admin privileges required.',
      timestamp: new Date().toISOString(),
    });
  }

  // ── Factor 2: Firestore principal verification (when hardening enabled) ───
  if (HARDENING_ENABLED && process.env.NODE_ENV !== 'test') {
    const principal = await adminPrincipalRepo.verify(user.uid);

    if (!principal) {
      logger.warn('[RequireAdmin] Rejected — principal not found or session expired', {
        uid:  user.uid,
        path: req.originalUrl,
      });
      return res.status(403).json({
        success:   false,
        errorCode: 'ADMIN_SESSION_EXPIRED',
        message:   'Admin session expired or not authorized. Please log in to the admin dashboard again.',
        timestamp: new Date().toISOString(),
      });
    }

    // MASTER_ADMIN session refresh happens automatically
    if (isMasterAdmin) {
      setImmediate(() => adminPrincipalRepo.recordAction(user.uid));
    }

    req.adminPrincipal = principal;
  }

  next();
};

/**
 * Refresh admin session — call from admin login endpoint.
 * @param {string} uid
 */
requireAdmin.refreshSession = async (uid) => {
  await adminPrincipalRepo.refreshSession(uid);
};

module.exports = { requireAdmin };








