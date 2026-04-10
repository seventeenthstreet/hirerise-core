'use strict';

/**
 * Wave 1 Drift Hardened AI Cost Guard Middleware
 *
 * Hardening:
 *  - RPC drift-safe read fallback
 *  - RPC drift-safe write fallback
 *  - timeout fail-open preserved
 *  - tier / limit numeric sanitization
 *  - middleware context contract stabilization
 */

const { supabase } = require('../config/supabase');
const logger = require('../utils/logger');

const GET_COST_RPC = 'get_ai_daily_cost';
const INCREMENT_COST_RPC = 'increment_ai_cost';

const DAILY_LIMITS_USD = Object.freeze({
  free: safePositiveNumber(
    process.env.AI_COST_LIMIT_FREE_USD,
    0.1
  ),
  pro: safePositiveNumber(
    process.env.AI_COST_LIMIT_PRO_USD,
    2.0
  ),
  elite: safePositiveNumber(
    process.env.AI_COST_LIMIT_ELITE_USD,
    10.0
  ),
  enterprise: safePositiveNumber(
    process.env.AI_COST_LIMIT_ENTERPRISE_USD,
    10.0
  ),
});

const DEFAULT_LIMIT_USD = DAILY_LIMITS_USD.free;
const RPC_TIMEOUT_MS = 1500;

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

function limitForTier(tier) {
  const normalizedTier = String(tier || 'free').toLowerCase();
  return DAILY_LIMITS_USD[normalizedTier] ?? DEFAULT_LIMIT_USD;
}

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('RPC_TIMEOUT')), timeoutMs)
    ),
  ]);
}

async function getDailySpend(userId) {
  try {
    const { data, error } = await withTimeout(
      supabase.rpc(GET_COST_RPC, {
        p_user_id: userId,
      }),
      RPC_TIMEOUT_MS
    );

    if (error) throw error;
    return normalizeSpend(data);
  } catch (err) {
    if (isRpcDrift(err)) {
      logger.warn('[AICostGuard] RPC drift fallback read', {
        userId,
        rpc: GET_COST_RPC,
        code: err.code,
        error: err.message,
      });

      return fallbackDailySpend(userId);
    }

    logger.error('[AICostGuard] getDailySpend failed', {
      userId,
      error: err.message,
    });

    return 0;
  }
}

async function recordAiCost(userId, tier, costUSD) {
  const normalizedCost = safePositiveNumber(costUSD, 0);
  if (normalizedCost <= 0) return false;

  try {
    const { error } = await withTimeout(
      supabase.rpc(INCREMENT_COST_RPC, {
        p_user_id: userId,
        p_cost: normalizedCost,
      }),
      RPC_TIMEOUT_MS
    );

    if (error) throw error;

    logger.debug('[AICostGuard] Cost recorded', {
      userId,
      tier,
      costUSD: normalizedCost,
    });

    return true;
  } catch (err) {
    if (isRpcDrift(err)) {
      logger.warn('[AICostGuard] RPC drift fallback write', {
        userId,
        rpc: INCREMENT_COST_RPC,
        code: err.code,
        error: err.message,
      });

      return fallbackRecordCost(userId, normalizedCost);
    }

    logger.warn('[AICostGuard] Failed to record AI cost', {
      userId,
      costUSD: normalizedCost,
      error: err.message,
    });

    return false;
  }
}

async function aiCostGuard(req, res, next) {
  const userId = req.user?.id;

  if (!userId) {
    logger.error('[AICostGuard] Missing req.user.id — authenticate required');

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
          remainingUSD: Number(Math.max(limit - spent, 0).toFixed(4)),
          resetsAt: `${todayISO()}T23:59:59Z`,
        },
      });
    }

    req._aiCostContext = {
      userId,
      tier,
      limit,
      spent,
      remaining: Math.max(limit - spent, 0),
      checkedAt: new Date().toISOString(),
    };

    return next();
  } catch (err) {
    logger.error('[AICostGuard] Unexpected failure — allowing request', {
      userId,
      error: err.message,
    });

    return next();
  }
}

function aiCostGuardFactory({ tierOverride } = {}) {
  return async function (req, res, next) {
    if (tierOverride && req.user) {
      req.user._tierForCostGuard = tierOverride;
    }

    return aiCostGuard(req, res, next);
  };
}

async function fallbackDailySpend(userId) {
  const today = todayISO();

  const { data, error } = await supabase
    .from('ai_cost_tracking')
    .select('total_cost_usd')
    .eq('user_id', userId)
    .eq('date', today)
    .eq('is_deleted', false)
    .maybeSingle();

  if (error) {
    logger.warn('[AICostGuard] fallbackDailySpend failed-open', {
      userId,
      error: error.message,
    });
    return 0;
  }

  return normalizeSpend(data?.total_cost_usd);
}

async function fallbackRecordCost(userId, costUSD) {
  const today = todayISO();
  const id = `${userId}_${today}`;

  const { error } = await supabase
    .from('ai_cost_tracking')
    .upsert(
      {
        id,
        user_id: userId,
        date: today,
        total_cost_usd: costUSD,
        updated_at: new Date().toISOString(),
        is_deleted: false,
      },
      { onConflict: 'id' }
    );

  if (error) {
    logger.warn('[AICostGuard] fallbackRecordCost failed-open', {
      userId,
      error: error.message,
    });
    return false;
  }

  return true;
}

function normalizeSpend(data) {
  if (Array.isArray(data)) {
    return normalizeSpend(data[0]);
  }

  if (data && typeof data === 'object') {
    return safePositiveNumber(
      data.total_cost_usd ?? data.daily_cost ?? data.cost,
      0
    );
  }

  return safePositiveNumber(data, 0);
}

function safePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function isRpcDrift(error) {
  const msg = String(error?.message || '').toLowerCase();
  return (
    error?.code === '42883' ||
    msg.includes('function') ||
    msg.includes('does not exist') ||
    msg.includes('schema cache')
  );
}

module.exports = {
  aiCostGuard,
  aiCostGuardFactory,
  recordAiCost,
  getDailySpend,
  limitForTier,
  DAILY_LIMITS_USD,
};