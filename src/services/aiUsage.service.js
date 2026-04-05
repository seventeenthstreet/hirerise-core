'use strict';

/**
 * @file src/services/aiUsage.service.js
 * @description
 * Monthly AI usage metering using Supabase RPC (atomic + quota-safe).
 *
 * Optimized for:
 * - atomic RPC quota enforcement
 * - fail-open UX safety
 * - snake_case Supabase writes
 * - stronger null safety
 * - structured logging
 * - insert error extraction
 * - production-ready async flow
 */

const { supabase } = require('../config/supabase');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// Monthly limits per tier
// ─────────────────────────────────────────────────────────────────────────────
const MONTHLY_LIMITS = Object.freeze({
  free: 5,
  pro: 100,
  elite: 500,
  enterprise: 500,
});

const DEFAULT_LIMIT = 5;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function normalizeTier(tier) {
  return String(tier || 'free').trim().toLowerCase();
}

function limitForTier(tier) {
  return MONTHLY_LIMITS[normalizeTier(tier)] ?? DEFAULT_LIMIT;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core: check + increment via RPC
// ─────────────────────────────────────────────────────────────────────────────
/**
 * checkAndIncrement(userId, tier)
 *
 * Calls Supabase RPC:
 *   increment_ai_usage(user_id, user_tier)
 *
 * Handles:
 * - atomic increment
 * - monthly reset
 * - quota enforcement
 * - fail-open on infrastructure issues
 */
async function checkAndIncrement(userId, tier) {
  const safeUserId = String(userId || '').trim();
  const safeTier = normalizeTier(tier);

  if (!safeUserId) {
    throw new AppError(
      'Valid userId is required for AI usage metering.',
      400,
      null,
      'INVALID_USER_ID'
    );
  }

  try {
    const { error } = await supabase.rpc('increment_ai_usage', {
      user_id: safeUserId,
      user_tier: safeTier,
    });

    if (!error) {
      return;
    }

    const errorMessage = String(error.message || '');

    // Quota exceeded should block request
    if (errorMessage.includes('QUOTA_EXCEEDED')) {
      throw new AppError(
        `Monthly AI usage limit reached for your ${safeTier} plan.`,
        429,
        {
          monthly_limit: limitForTier(safeTier),
          tier: safeTier,
        },
        'QUOTA_EXCEEDED'
      );
    }

    throw error;
  } catch (err) {
    if (err instanceof AppError) {
      throw err;
    }

    // Fail open for better UX on transient DB issues
    logger.error('[AiUsage] RPC failed — failing open', {
      user_id: safeUserId,
      tier: safeTier,
      error: err?.message || 'Unknown RPC error',
    });

    return;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fire-and-forget usage logging
// ─────────────────────────────────────────────────────────────────────────────
/**
 * logAiCall(params)
 *
 * Non-blocking logging into ai_usage_logs table.
 * Logging failure must never affect request flow.
 */
async function logAiCall({
  userId,
  feature,
  model,
  success,
  errorCode = null,
}) {
  const payload = {
    user_id: String(userId || '').trim() || null,
    feature: String(feature || 'unknown'),
    model: String(model || 'unknown'),
    success: success ?? true,
    error_code: errorCode,
    created_at: new Date().toISOString(),
  };

  try {
    const { error } = await supabase
      .from('ai_usage_logs')
      .insert(payload);

    if (error) {
      logger.warn('[AiUsage] Usage log insert failed', {
        user_id: payload.user_id,
        error: error.message,
      });
    }
  } catch (err) {
    logger.warn('[AiUsage] Usage log unexpected failure', {
      user_id: payload.user_id,
      error: err?.message || 'Unknown insert error',
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  checkAndIncrement,
  logAiCall,
  limitForTier,
  MONTHLY_LIMITS,
};