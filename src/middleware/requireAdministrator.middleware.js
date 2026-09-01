'use strict';

/**
 * requireAdministrator.middleware.js
 *
 * Blocker 1 — Administrator lifecycle authorization for routes that were
 * previously gated solely by verifyAdmin.middleware.js's JWT-only role
 * check (`req.user.role` / `req.user.roles`, no admin_principals lookup).
 *
 * SCOPE: this is the DB-backed drop-in replacement for the historical
 *
 *     verifyAdmin.middleware.js#verifyAdmin
 *
 * boundary — i.e. "admin OR super_admin", exactly as that guard checked
 * it (`role === 'admin' || role === 'super_admin'`, or the equivalent
 * value in `req.user.roles`). It intentionally preserves that guard's
 * historical exclusion of MASTER_ADMIN: the old verifyAdmin() had no
 * MASTER_ADMIN branch, so a MASTER_ADMIN JWT without an 'admin' or
 * 'super_admin' entry in role/roles was already denied by the code this
 * replaces. This middleware must keep denying MASTER_ADMIN for the same
 * reason requireAdmin.middleware.js and requireMasterAdmin.middleware.js
 * are kept as separate guards rather than merged: role-boundary changes
 * are out of scope for a lifecycle-authorization migration.
 *
 * WHY THIS EXISTS: unlike requireAdmin.middleware.js (already DB-backed)
 * and requireMasterAdmin.middleware.js (migrated under WP-ADMIN-INTEL-02),
 * verifyAdmin.middleware.js has never queried admin_principals. Any live
 * route mounted with verifyAdmin and NOT also sitting behind mount-level
 * requireAdmin therefore accepted a suspended/revoked/expired
 * administrator's still-valid JWT indefinitely. The one confirmed live
 * instance of this gap is:
 *
 *     GET /api/v1/onboarding/analytics/funnel
 *
 * which is mounted at `${API_PREFIX}/onboarding` behind `authenticate`
 * only (see server.js) — verifyAdmin was the *sole* admin boundary on
 * that route, with no outer requireAdmin to catch a stale lifecycle
 * state. (Other routes that also import verifyAdmin/verifySuperAdmin —
 * adminMetrics, ai-observability, xaiMetrics, systemHealth,
 * modules/adaptiveWeight — are all mounted behind mount-level
 * `authenticate, requireAdmin, requireElevatedSession` already, so those
 * JWT-only route-local checks, while worth cleaning up for consistency,
 * do not currently allow a lifecycle bypass: requireAdmin already
 * rejects a suspended/revoked/expired principal before the request
 * reaches them.)
 *
 * Mirrors requireMasterAdmin.middleware.js's verification contract
 * verbatim: same repository (adminPrincipal.repository.js#verify()),
 * same SHOULD_VERIFY_DB convention, same lifecycle error codes as
 * requireAdmin.middleware.js. No new authorization model.
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

const ALLOWED_ROLES = ['admin', 'super_admin'];

const HARDENING_ENABLED = process.env.ADMIN_HARDENING_ENABLED === 'true';
const IS_PRODUCTION_ADMIN = process.env.NODE_ENV === 'production';
// Mirrors requireAdmin.middleware.js / requireMasterAdmin.middleware.js:
// DB verification is ALWAYS on in production; ADMIN_HARDENING_ENABLED is
// only consulted outside production. A misconfigured flag can NEVER
// disable protection in production.
const SHOULD_VERIFY_DB = IS_PRODUCTION_ADMIN || HARDENING_ENABLED;

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
  return roles.filter((r) => typeof r === 'string');
}

// Matches verifyAdmin.middleware.js#hasAdminAccess exactly (including its
// `user.admin === true` escape hatch), so pre-migration callers that relied
// on any of those three shapes keep working identically.
function hasAdministratorClaim(user) {
  const role = typeof user.role === 'string' ? user.role : '';
  const roles = normalizeRoles(user.roles);

  return (
    user.admin === true ||
    ALLOWED_ROLES.includes(role) ||
    roles.some((r) => ALLOWED_ROLES.includes(r))
  );
}

// Same lifecycle error contract as requireAdmin.middleware.js /
// requireMasterAdmin.middleware.js, kept local for the same reason
// requireMasterAdmin does: no coupling to another guard's unexported
// internals.
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

const requireAdministrator = async (req, res, next) => {
  const requestId = getRequestId(req);
  const user = req.user;

  // ── Auth check ─────────────────────────────────────────
  if (!user) {
    return res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Authentication required.' },
      requestId,
      timestamp: new Date().toISOString(),
    });
  }

  // ── Claim check (unchanged historical boundary: admin OR super_admin) ──
  if (!hasAdministratorClaim(user)) {
    logger.warn('[RequireAdministrator] No admin/super_admin claim', {
      requestId,
      userId: user.uid,
      role: user.role,
      roles: user.roles,
      path: req.originalUrl,
      ip: req.ip,
    });

    return res.status(403).json({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Admin privileges required.' },
      requestId,
      timestamp: new Date().toISOString(),
    });
  }

  // ── admin_principals lifecycle verification (hardening) ─────────────
  // A valid admin/super_admin JWT claim is necessary but no longer
  // sufficient: the caller's admin_principals row must also still be
  // status='active' (and, per verify()'s own rules, within the session
  // TTL — admin/super_admin do not get MASTER_ADMIN's TTL exemption,
  // matching requireAdmin.middleware.js's existing session-expiry check).
  if (SHOULD_VERIFY_DB) {
    try {
      const principal = await principalRepo.verify(user.uid);

      if (!principal) {
        const raw = await principalRepo.getPrincipal(user.uid);
        const { code, message } = lifecycleErrorCode(raw?.status ?? null);

        logger.warn('[RequireAdministrator] Principal invalid', {
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
              via: 'requireAdministrator',
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

      // ── Preserve the historical role boundary ──────────────────────
      // A principal can be lifecycle-active but hold a role this guard
      // was never meant to admit (e.g. MASTER_ADMIN, or any future
      // role). Denying here — after lifecycle verification, using the
      // authoritative admin_principals.role rather than the JWT's — is
      // what keeps this guard from silently broadening access to
      // MASTER_ADMIN, which is exactly the drift Blocker 1 exists to
      // prevent.
      if (!ALLOWED_ROLES.includes(principal.role)) {
        logger.warn('[RequireAdministrator] Principal role not permitted', {
          requestId,
          userId: user.uid,
          role: principal.role,
          path: req.originalUrl,
        });

        return res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Admin privileges required.' },
          requestId,
          timestamp: new Date().toISOString(),
        });
      }

      req.adminPrincipal = principal;
    } catch (err) {
      // Fail-closed: never fall back to the JWT claim alone.
      logger.error('[RequireAdministrator] Verification failed', {
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

module.exports = { requireAdministrator };
