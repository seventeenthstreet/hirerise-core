'use strict';

/**
 * requireAdmin.middleware.js (Production Optimized)
 */

const crypto = require('crypto');
const logger = require('../utils/logger');
const { supabase } = require('../config/supabase'); // ✅ optimized import

const HARDENING_ENABLED = process.env.ADMIN_HARDENING_ENABLED === 'true';
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
    supabase
      .from('admin_principals')
      .select('*')
      .eq('user_id', userId)
      .eq('is_active', true)
      .maybeSingle(),

    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('ADMIN_VERIFY_TIMEOUT')), 2000)
    ),
  ]);
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
  if (HARDENING_ENABLED && process.env.NODE_ENV !== 'test') {
    try {
      const { data, error } = await safeVerify(user.uid);

      if (error || !data) {
        logger.warn('[RequireAdmin] Principal invalid', {
          requestId,
          userId: user.uid,
          error: error?.message,
        });

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
            .eq('user_id', user.uid);
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
      .upsert({
        user_id: userId,
        is_active: true,
        verified_at: new Date().toISOString(),
      });
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