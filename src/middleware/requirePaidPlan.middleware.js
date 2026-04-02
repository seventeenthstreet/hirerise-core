'use strict';

/**
 * requirePaidPlan.middleware.js (Production Optimized)
 */

const { supabase } = require('../config/supabase'); // ✅ KEEP THIS
const { normalizeTier } = require('./requireTier.middleware');
const logger = require('../utils/logger');

const PAID_TIERS = new Set(['pro', 'elite', 'enterprise', 'premium']);

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function getRequestId(req) {
  return (
    req.correlationId ||
    req.headers['x-correlation-id'] ||
    req.headers['x-request-id']
  );
}

function isAdmin(user) {
  return (
    user.admin === true ||
    ['admin', 'super_admin'].includes(user.role ?? '') ||
    (user.roles ?? []).includes('admin')
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────

async function requirePaidPlan(req, res, next) {
  const requestId = getRequestId(req);

  // ── Auth check ─────────────────────────────────────────
  if (!req.user) {
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

  const userId = req.user.uid;

  // ── Admin bypass ───────────────────────────────────────
  if (isAdmin(req.user)) return next();

  // ── Fast path (JWT) ────────────────────────────────────
  const jwtTier = normalizeTier(req.user.plan);

  if (PAID_TIERS.has(jwtTier)) {
    req.user.normalizedTier = jwtTier;
    return next();
  }

  // ── DB fallback (Supabase) ─────────────────────────────
  try {
    const { data, error } = await supabase
      .from('users')
      .select('tier, plan')
      .eq('id', userId)
      .maybeSingle();

    if (error) throw error;

    const dbTier = normalizeTier(data?.tier ?? data?.plan ?? null);

    if (PAID_TIERS.has(dbTier)) {
      logger.info('[requirePaidPlan] DB tier grants access', {
        requestId,
        userId,
        tier: dbTier,
        path: req.originalUrl,
      });

      req.user.plan = dbTier;
      req.user.normalizedTier = dbTier;

      // ── Async JWT backfill (non-blocking) ───────────────
      setImmediate(() => {
        supabase.auth.admin
          .updateUserById(userId, {
            app_metadata: {
              ...(req.user.customClaims ?? {}),
              plan: dbTier,
            },
          })
          .catch(err => {
            logger.warn('[requirePaidPlan] Claim backfill failed', {
              requestId,
              userId,
              error: err.message,
            });
          });
      });

      return next();
    }

  } catch (err) {
    logger.warn('[requirePaidPlan] DB lookup failed', {
      requestId,
      userId,
      error: err.message,
      path: req.originalUrl,
    });
  }

  // ── Block free users ───────────────────────────────────
  logger.warn('[requirePaidPlan] Access denied (free tier)', {
    requestId,
    userId,
    tier: jwtTier,
    path: req.originalUrl,
  });

  return res.status(403).json({
    success: false,
    error: {
      code: 'PLAN_UPGRADE_REQUIRED',
      message: 'This feature requires a paid plan. Please upgrade to continue.',
    },
    requestId,
    timestamp: new Date().toISOString(),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────────────────────────────────────

module.exports = { requirePaidPlan };