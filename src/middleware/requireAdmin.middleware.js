'use strict';

/**
 * requireAdmin.middleware.js (Production Optimized)
 */

const crypto = require('crypto');
const logger = require('../utils/logger');
const { supabase } = require('../config/supabase'); // ✅ optimized import
const { logAdminAction } = require('../utils/adminAuditLogger');
const {
  ACTIONS: LIFECYCLE_AUDIT_ACTIONS,
  buildLifecycleAuditEvent,
} = require('../domain/admin/lifecycle/adminLifecycle.audit');

const HARDENING_ENABLED = process.env.ADMIN_HARDENING_ENABLED === 'true';
const IS_PRODUCTION_ADMIN = process.env.NODE_ENV === 'production';
// DB verification is ALWAYS on in production. ADMIN_HARDENING_ENABLED is only
// consulted in non-production (dev/staging) so test environments can opt out.
// A misconfigured flag can NEVER disable protection in production.
const SHOULD_VERIFY_DB = IS_PRODUCTION_ADMIN || HARDENING_ENABLED;

const ADMIN_SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h

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

async function safeVerify(userId) {
  return Promise.race([
    // BUGFIX (WP-ADMIN-04F-18B): admin_principals' primary key column is
    // `uid`, not `user_id` — there is no `user_id` column on this table.
    // The previous `.eq('user_id', userId)` filter matched nothing for
    // any admin, making DB verification a silent no-op (or a hard error,
    // depending on the Supabase client's behaviour for an unknown
    // column) whenever SHOULD_VERIFY_DB was true. Fixed here because
    // lifecycle enforcement (Phase 6) depends on this query actually
    // reaching the row it's meant to check; this is a minimal column-name
    // correction, not a redesign of the verification layer.
    //
    // status is also selected explicitly (in addition to `*`) so callers
    // can distinguish suspended/revoked/expired without a second query.
    supabase
      .from('admin_principals')
      .select('*')
      .eq('uid', userId)
      .eq('status', 'active')
      .maybeSingle(),

    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('ADMIN_VERIFY_TIMEOUT')), 2000)
    ),
  ]);
}

/**
 * Fetch the raw principal (any lifecycle status) so a failed verification
 * can report *why* it failed (suspended vs revoked vs expired vs simply
 * unknown), without weakening the pass/fail check itself.
 */
async function fetchPrincipalForDiagnostics(userId) {
  try {
    const { data } = await supabase
      .from('admin_principals')
      .select('status')
      .eq('uid', userId)
      .maybeSingle();
    return data?.status ?? null;
  } catch {
    return null;
  }
}

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

function hasAdminClaim(user) {
  const roles = user.roles ?? [];

  return (
    user.admin === true ||
    user.role === 'admin' ||
    user.role === 'super_admin' ||
    roles.includes('admin') ||
    roles.includes('super_admin')
  );
}

function isMasterAdmin(user) {
  return (
    user.role === 'MASTER_ADMIN' ||
    (user.roles ?? []).includes('MASTER_ADMIN')
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────

const requireAdmin = async (req, res, next) => {
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

  const master = isMasterAdmin(user);
  const hasClaim = master || hasAdminClaim(user);

  // ── Claim check ────────────────────────────────────────
  if (!hasClaim) {
    logger.warn('[RequireAdmin] No admin claim', {
      requestId,
      userId: user.uid,
      role: user.role,
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

  // ── Supabase verification (hardening) ─────────────────
  if (SHOULD_VERIFY_DB) {
    try {
      const { data, error } = await safeVerify(user.uid);

      if (error || !data) {
        // Not active (or no row at all) — find out which lifecycle state
        // it's actually in so we can return a precise reason. This is a
        // diagnostic-only read; it never grants access.
        const actualStatus = await fetchPrincipalForDiagnostics(user.uid);
        const { code, message } = lifecycleErrorCode(actualStatus);

        logger.warn('[RequireAdmin] Principal invalid', {
          requestId,
          userId: user.uid,
          status: actualStatus,
          error: error?.message,
        });

        // WP-ADMIN-04F-18C: persisted audit record for the verification
        // failure, in addition to the existing Winston log line above.
        // Fire-and-forget — logAdminAction() never throws, and this call
        // happens strictly *after* the 403 decision has already been
        // made, so an audit-write failure can never turn this into a
        // pass. Authorization behaviour is unchanged.
        void logAdminAction(
          buildLifecycleAuditEvent(
            LIFECYCLE_AUDIT_ACTIONS.VERIFICATION_FAILED,
            user.uid,
            user.uid,
            {
              status: actualStatus,
              reason: error?.message ?? null,
              path: req.originalUrl,
              requestId,
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

      // ── Session expiry check ───────────────────────────
      if (!master && data.verified_at) {
        const lastVerified = new Date(data.verified_at).getTime();

        if (Date.now() - lastVerified > ADMIN_SESSION_TTL_MS) {
          return res.status(403).json({
            success: false,
            error: {
              code: 'ADMIN_SESSION_EXPIRED',
              message: 'Admin session expired. Please log in again.',
            },
            requestId,
            timestamp: new Date().toISOString(),
          });
        }
      }

      req.adminPrincipal = data;

      // ── Async audit log ───────────────────────────────
      setImmediate(async () => {
        try {
          await supabase
            .from('admin_principals')
            .update({ last_action_at: new Date().toISOString() })
            .eq('uid', user.uid); // BUGFIX: was 'user_id' (no such column)
        } catch (err) {
          logger.warn('[RequireAdmin] Audit update failed', {
            userId: user.uid,
            error: err.message,
          });
        }
      });

    } catch (err) {
      logger.error('[RequireAdmin] Verification failed', {
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
// SESSION REFRESH
// ─────────────────────────────────────────────────────────────────────────────

requireAdmin.refreshSession = async (userId) => {
  try {
    await supabase
      .from('admin_principals')
      .update({
        // BUGFIX: was 'user_id' / 'is_active' upsert — no such column,
        // and upsert without the required uid/role/granted_by columns
        // would fail admin_principals' NOT NULL constraints anyway.
        // refreshSession() only ever touches an *existing* row here;
        // provisioning a new principal is adminPrincipal.repository's
        // refreshSession(), which this helper intentionally does not
        // duplicate.
        status: 'active',
        verified_at: new Date().toISOString(),
      })
      .eq('uid', userId);
  } catch (err) {
    logger.warn('[RequireAdmin] refreshSession failed', {
      userId,
      error: err.message,
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────────────────────────────────────

module.exports = { requireAdmin };