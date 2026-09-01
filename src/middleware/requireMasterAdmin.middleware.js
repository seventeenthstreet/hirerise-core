'use strict';

/**
 * requireMasterAdmin.middleware.js (Production Optimized)
 *
 * WP-ADMIN-INTEL-02 — Master Admin Authority Verification & Security
 * Hardening.
 *
 * PRIOR BEHAVIOUR: this middleware authorized purely from the JWT's
 * MASTER_ADMIN claim (req.user.role / req.user.roles). It never checked
 * whether the corresponding admin_principals row was still active, unlike
 * requireAdmin.middleware.js, which has enforced the certified
 * admin_principals lifecycle (active / suspended / revoked / expired)
 * since WP-ADMIN-04F-18B. That gap meant a MASTER_ADMIN whose access had
 * been revoked or suspended — but who still held an already-issued,
 * unexpired JWT — could continue to pass this check indefinitely for any
 * route mounted with `requireMasterAdmin` alone (no `requireAdmin` in
 * front of it), e.g. /master/apis, /master/sync, /admin/secrets,
 * /admin/market-intelligence.
 *
 * FIX: after the existing JWT-claim check, this middleware now verifies
 * the caller's admin_principals row via the certified, already-tested
 * adminPrincipal.repository.js#verify() — the same repository method
 * requireAdmin's own DB-verification path is built on top of, and the one
 * the repository's own docstring identifies as the authoritative
 * lifecycle gate (status='active', MASTER_ADMIN exempt only from the 24h
 * session TTL, never from lifecycle status). No new authorization model,
 * no new lifecycle states, no new Supabase query shape — this reuses the
 * existing verification contract verbatim.
 *
 * Gated by the same SHOULD_VERIFY_DB convention requireAdmin.middleware.js
 * already uses: always on in production, opt-in via ADMIN_HARDENING_ENABLED
 * elsewhere (e.g. test/dev), so a misconfigured flag can never disable
 * protection in production, and existing non-production test suites that
 * stub req.user without a backing DB row are unaffected.
 */

const crypto = require('crypto');
const logger = require('../utils/logger');
const principalRepo = require('../modules/admin/repository/adminPrincipal.repository');
const { logAdminAction } = require('../utils/adminAuditLogger');
const {
  ACTIONS: LIFECYCLE_AUDIT_ACTIONS,
  buildLifecycleAuditEvent,
} = require('../domain/admin/lifecycle/adminLifecycle.audit');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const MASTER_ADMIN_ROLE = 'MASTER_ADMIN';

const HARDENING_ENABLED = process.env.ADMIN_HARDENING_ENABLED === 'true';
const IS_PRODUCTION_ADMIN = process.env.NODE_ENV === 'production';
// Mirrors requireAdmin.middleware.js: DB verification is ALWAYS on in
// production; ADMIN_HARDENING_ENABLED is only consulted outside production
// so test/dev environments can opt in without a real Supabase-backed
// admin_principals table. A misconfigured flag can NEVER disable
// protection in production.
const SHOULD_VERIFY_DB = IS_PRODUCTION_ADMIN || HARDENING_ENABLED;

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

// Mirrors requireAdmin.middleware.js#lifecycleErrorCode verbatim (same
// lifecycle states, same error contract) so a MASTER_ADMIN and a regular
// admin see identical error codes/messages for the same underlying
// admin_principals state. Kept local rather than imported so this file
// has no coupling to requireAdmin's internals (which are not exported)
// and so requireAdmin.middleware.js — already certified and tested — is
// left untouched by this work package.
function lifecycleErrorCode(status) {
  switch (status) {
    case 'suspended':
      return { code: 'ADMIN_SUSPENDED', message: 'Admin access is suspended.' };
    case 'revoked':
      return { code: 'ADMIN_REVOKED', message: 'Admin access has been revoked.' };
    case 'expired':
      return { code: 'ADMIN_EXPIRED', message: 'Admin access has expired.' };
    default:
      return {
        code: 'ADMIN_SESSION_EXPIRED',
        message: 'Admin session expired. Please log in again.',
      };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────

const requireMasterAdmin = async (req, res, next) => {
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

  // ── Claim check ────────────────────────────────────────
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

  // ── admin_principals lifecycle verification (hardening) ─
  // A valid MASTER_ADMIN JWT claim is necessary but no longer sufficient:
  // the caller's admin_principals row must also still be status='active'.
  // principalRepo.verify() already exempts MASTER_ADMIN from the 24h
  // session TTL — it does not exempt it from lifecycle status.
  if (SHOULD_VERIFY_DB) {
    try {
      const principal = await principalRepo.verify(user.uid);

      if (!principal) {
        // verify() intentionally returns null for "no row", "wrong
        // status", and "TTL expired" alike (fail-closed, no reason
        // leaked). Fetch the raw row separately — diagnostic-only, never
        // used to grant access — so the response/audit trail can report
        // *why* without weakening the pass/fail decision above.
        const raw = await principalRepo.getPrincipal(user.uid);
        const { code, message } = lifecycleErrorCode(raw?.status ?? null);

        logger.warn('[RequireMasterAdmin] Principal invalid', {
          requestId,
          userId: user.uid,
          status: raw?.status ?? null,
        });

        void logAdminAction(
          buildLifecycleAuditEvent(
            LIFECYCLE_AUDIT_ACTIONS.VERIFICATION_FAILED,
            user.uid,
            user.uid,
            {
              status: raw?.status ?? null,
              path: req.originalUrl,
              requestId,
              via: 'requireMasterAdmin',
            },
            req.ip
          )
        ).catch(() => {});

        return res.status(403).json({
          success: false,
          error: { code, message },
          requestId,
          timestamp: new Date().toISOString(),
        });
      }

      req.adminPrincipal = principal;
    } catch (err) {
      // Fail-closed: if the lifecycle check itself cannot be completed,
      // do not fall back to the JWT claim alone.
      logger.error('[RequireMasterAdmin] Verification failed', {
        requestId,
        userId: user.uid,
        error: err.message,
      });

      return res.status(503).json({
        success: false,
        error: {
          code: 'ADMIN_SERVICE_UNAVAILABLE',
          message: 'Admin verification service unavailable.',
        },
        requestId,
        timestamp: new Date().toISOString(),
      });
    }
  }

  return next();
};

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────────────────────────────────────

module.exports = { requireMasterAdmin };