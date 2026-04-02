'use strict';

/**
 * aiRateLimitByPlan.middleware.js (Supabase Production Version)
 */

const { supabase } = require('../config/supabase'); // ✅ REQUIRED
const logger = require('../utils/logger');
const { normalizeTier } = require('./requireTier.middleware');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const PLAN_LIMITS = Object.freeze({
  free:       parseInt(process.env.AI_RATE_LIMIT_FREE       || '5',   10),
  pro:        parseInt(process.env.AI_RATE_LIMIT_PRO        || '100', 10),
  elite:      parseInt(process.env.AI_RATE_LIMIT_ELITE      || '100', 10),
  premium:    parseInt(process.env.AI_RATE_LIMIT_PREMIUM    || '100', 10),
  enterprise: null, // unlimited
});

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function secondsUntilMidnight() {
  const now = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1
  ));
  return Math.ceil((next - now) / 1000);
}

function buildKey(plan, uid) {
  return `ai_rate_plan:${plan}:${uid}:${todayKey()}`;
}

function limitResponse(limit, plan) {
  return {
    success: false,
    error: {
      code: 'RATE_LIMITED',
      message: `You've reached your daily limit of ${limit} AI requests on the ${plan} plan. Your limit resets at UTC midnight.`,
    },
    retryAfterSeconds: secondsUntilMidnight(),
  };
}

function unavailableResponse() {
  return {
    success: false,
    error: {
      code: 'RATE_LIMIT_SERVICE_UNAVAILABLE',
      message: 'Rate limiting service temporarily unavailable. Please try again shortly.',
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE RPC
// ─────────────────────────────────────────────────────────────────────────────

async function checkPlanRateLimit(key, limit) {
  const { data, error } = await supabase.rpc('check_rate_limit', {
    p_key: key,
    p_limit: limit,
    p_window_seconds: 86400, // 24 hours
  });

  if (error) throw error;
  return data === true;
}

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────

async function aiRateLimitByPlan(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Authentication required.' },
    });
  }

  const uid = req.user.uid;

  // ─── Admin bypass ─────────────────────────────────────────
  const isAdmin =
    req.user.admin === true ||
    ['admin', 'super_admin'].includes(req.user.role ?? '') ||
    (req.user.roles ?? []).includes('admin');

  if (isAdmin) return next();

  const plan  = normalizeTier(req.user.plan);
  const limit = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;

  // Unlimited plans
  if (limit === null) return next();

  const key = buildKey(plan, uid);

  try {
    const allowed = await checkPlanRateLimit(key, limit);

    if (!allowed) {
      logger.warn('[aiRateLimitByPlan] Limit exceeded', {
        uid,
        plan,
        limit,
        path: req.path,
      });

      return res.status(429).json(limitResponse(limit, plan));
    }

    return next();

  } catch (err) {
    logger.error('[aiRateLimitByPlan] Supabase RPC failed', {
      uid,
      plan,
      error: err.message,
    });

    // ✅ Production: fail CLOSED (as per your original design)
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json(unavailableResponse());
    }

    // Dev: fail OPEN
    logger.warn('[aiRateLimitByPlan] Failing OPEN (dev mode)');
    return next();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = { aiRateLimitByPlan };