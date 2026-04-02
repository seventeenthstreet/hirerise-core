'use strict';

/**
 * aiCostGuard.middleware.js
 *
 * Production-grade AI cost guard using Supabase (Postgres RPC).
 *
 * Features:
 *  - Atomic daily cost tracking
 *  - Tier-based limits
 *  - Fail-open safety (never blocks due to DB issues)
 *  - Minimal latency (single RPC read + write)
 *
 * REQUIRED RPCs:
 *  - get_ai_daily_cost(p_user_id text)
 *  - increment_ai_cost(p_user_id text, p_cost numeric)
 */

const { supabase } = require('../config/supabase');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const DAILY_LIMITS_USD = Object.freeze({
  free:       parseFloat(process.env.AI_COST_LIMIT_FREE_USD       || '0.10'),
  pro:        parseFloat(process.env.AI_COST_LIMIT_PRO_USD        || '2.00'),
  elite:      parseFloat(process.env.AI_COST_LIMIT_ELITE_USD      || '10.00'),
  enterprise: parseFloat(process.env.AI_COST_LIMIT_ENTERPRISE_USD || '10.00'),
});

const DEFAULT_LIMIT_USD = DAILY_LIMITS_USD.free;

// Optional timeout protection (ms)
const RPC_TIMEOUT_MS = 1500;

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

function limitForTier(tier) {
  const t = String(tier || 'free').toLowerCase();
  return DAILY_LIMITS_USD[t] ?? DEFAULT_LIMIT_USD;
}

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('RPC_TIMEOUT')), timeoutMs)
    ),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

async function getDailySpend(userId) {
  try {
    const { data, error } = await withTimeout(
      supabase.rpc('get_ai_daily_cost', {
        p_user_id: userId,
      }),
      RPC_TIMEOUT_MS
    );

    if (error) throw error;

    return Number(data || 0);
  } catch (err) {
    logger.error('[AICostGuard] getDailySpend failed', {
      userId,
      error: err.message,
    });

    return 0; // Fail-open
  }
}

async function recordAiCost(userId, tier, costUSD) {
  if (!costUSD || costUSD <= 0) return;

  try {
    const { error } = await withTimeout(
      supabase.rpc('increment_ai_cost', {
        p_user_id: userId,
        p_cost: costUSD,
      }),
      RPC_TIMEOUT_MS
    );

    if (error) throw error;

    logger.debug('[AICostGuard] Cost recorded', {
      userId,
      tier,
      costUSD,
    });

  } catch (err) {
    logger.warn('[AICostGuard] Failed to record AI cost', {
      userId,
      costUSD,
      error: err.message,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────

async function aiCostGuard(req, res, next) {
  const userId = req.user?.uid;

  // Safety: ensure authentication ran first
  if (!userId) {
    logger.error('[AICostGuard] Missing req.user — authenticate required');

    return res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authentication required.',
      },
    });
  }

  try {
    const tier =
      req.user.normalizedTier ||
      req.user.plan ||
      req.user._tierForCostGuard ||
      'free';

    const limit = limitForTier(tier);
    const spent = await getDailySpend(userId);

    // 🚫 BLOCK if limit exceeded
    if (spent >= limit) {
      logger.warn('[AICostGuard] Daily limit exceeded', {
        userId,
        tier,
        spent,
        limit,
      });

      return res.status(429).json({
        success: false,
        error: {
          code: 'DAILY_AI_COST_LIMIT_EXCEEDED',
          message: 'Daily AI usage limit reached. Resets at midnight UTC.',
        },
        detail: {
          dailySpentUSD: Number(spent.toFixed(4)),
          dailyLimitUSD: limit,
          resetsAt: `${todayISO()}T23:59:59Z`,
        },
      });
    }

    // Attach context for downstream usage (optional)
    req._aiCostContext = {
      userId,
      tier,
      limit,
      spent,
    };

    return next();

  } catch (err) {
    // Fail-open (critical for UX)
    logger.error('[AICostGuard] Unexpected failure — allowing request', {
      userId,
      error: err.message,
    });

    return next();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FACTORY
// ─────────────────────────────────────────────────────────────────────────────

function aiCostGuardFactory({ tierOverride } = {}) {
  return async function (req, res, next) {
    if (tierOverride && req.user) {
      req.user._tierForCostGuard = tierOverride;
    }
    return aiCostGuard(req, res, next);
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  aiCostGuard,
  aiCostGuardFactory,
  recordAiCost,
  getDailySpend,
  limitForTier,
  DAILY_LIMITS_USD,
};