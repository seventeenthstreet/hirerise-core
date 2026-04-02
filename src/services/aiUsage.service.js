'use strict';

/**
 * aiUsage.service.js
 *
 * Monthly AI usage metering using Supabase RPC (atomic, safe).
 */

const { supabase } = require('../config/supabase');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

// ─── Monthly limits per tier ────────────────────────────────────────────────

const MONTHLY_LIMITS = {
  free: 5,
  pro: 100,
  elite: 500,
  enterprise: 500
};

const DEFAULT_LIMIT = 5;

// ─── Helpers ───────────────────────────────────────────────────────────────

function limitForTier(tier) {
  return MONTHLY_LIMITS[tier] ?? DEFAULT_LIMIT;
}

// ─── Core: check + increment via RPC ────────────────────────────────────────

/**
 * checkAndIncrement(userId, tier)
 *
 * Calls Supabase RPC:
 *   increment_ai_usage(user_id, user_tier)
 *
 * Handles:
 *   - Atomic increment
 *   - Monthly reset
 *   - Quota enforcement
 */
async function checkAndIncrement(userId, tier) {
  try {
    const { error } = await supabase.rpc('increment_ai_usage', {
      user_id: userId,
      user_tier: tier
    });

    if (error) {
      // Handle quota exceeded cleanly
      if (error.message && error.message.includes('QUOTA_EXCEEDED')) {
        throw new AppError(
          `Monthly AI usage limit reached for your ${tier} plan.`,
          429,
          {
            monthlyLimit: limitForTier(tier),
            tier
          },
          'QUOTA_EXCEEDED'
        );
      }

      throw error;
    }

  } catch (err) {
    if (err instanceof AppError) {
      throw err;
    }

    // Fail open (important for UX)
    logger.error('[AiUsage] RPC failed — failing open', {
      userId,
      tier,
      error: err.message
    });
  }
}

// ─── Fire-and-forget: log usage ─────────────────────────────────────────────

/**
 * logAiCall(params)
 *
 * Non-blocking logging into ai_usage_logs table
 */
async function logAiCall({
  userId,
  feature,
  model,
  success,
  errorCode = null
}) {
  try {
    await supabase.from('ai_usage_logs').insert({
      userId,
      feature: feature ?? 'unknown',
      model: model ?? 'unknown',
      success: success ?? true,
      errorCode,
      createdAt: new Date().toISOString()
    });
  } catch (_err) {
    // Intentionally silent — logging must never affect main flow
  }
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  checkAndIncrement,
  logAiCall,
  limitForTier,
  MONTHLY_LIMITS
};