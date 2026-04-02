'use strict';

/**
 * coverLetter.service.js
 *
 * Production-grade Supabase orchestration layer.
 *
 * Responsibilities:
 * - tier safety enforcement
 * - atomic credit deduction via consume_ai_credits RPC
 * - Claude engine orchestration
 * - atomic credit refund via refund_ai_credits RPC on engine failure
 * - non-fatal persistence
 * - async usage logging
 */

const { supabase } = require('../../config/supabase');
const {
  AppError,
  ErrorCodes,
} = require('../../middleware/errorHandler');
const logger = require('../../utils/logger');
const {
  generateCoverLetter,
} = require('./engine/coverLetter.engine');

const FEATURE_ID = 'cover_letter';
const CREDIT_COST = 2;
const FREE_TIERS = new Set(['free']);

// ─────────────────────────────────────────────────────────────────────────────
// USAGE LOGGER (SUPABASE-NATIVE, NON-BLOCKING)
// ─────────────────────────────────────────────────────────────────────────────

async function logUsageAsync(payload) {
  try {
    await supabase
      .from('usage_logs')
      .insert({
        user_id: payload.userId,
        feature: payload.feature,
        tier: payload.tier,
        model: payload.model,
        input_tokens: payload.inputTokens,
        output_tokens: payload.outputTokens,
        plan_amount: payload.planAmount,
        created_at: new Date().toISOString(),
      });
  } catch (error) {
    logger.warn('[CoverLetterService] Usage log failed (non-fatal)', {
      userId: payload.userId,
      error: error.message,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ATOMIC CREDIT HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function deductCredits(userId, amount) {
  const { data, error } = await supabase.rpc('consume_ai_credits', {
    p_user_id: userId,
    p_amount: amount,
  });

  if (error) {
    if (error.message?.includes('INSUFFICIENT_CREDITS')) {
      throw new AppError(
        'Insufficient AI credits. Please purchase a new plan.',
        402,
        { creditsRequired: amount },
        ErrorCodes.PAYMENT_REQUIRED
      );
    }

    throw new AppError(
      'Failed to deduct credits.',
      500,
      { error: error.message },
      ErrorCodes.DB_ERROR
    );
  }

  logger.debug('[CoverLetterService] Credits deducted', {
    userId,
    amount,
    creditsRemaining: data,
  });

  return { creditsRemaining: data };
}

async function refundCredits(userId, amount) {
  try {
    const { data, error } = await supabase.rpc('refund_ai_credits', {
      p_user_id: userId,
      p_amount: amount,
    });

    if (error) throw error;

    logger.debug('[CoverLetterService] Credits refunded', {
      userId,
      amount,
      creditsRemaining: data,
    });
  } catch (error) {
    logger.error(
      '[CoverLetterService] Refund failed — manual reconciliation required',
      {
        userId,
        amount,
        error: error.message,
      }
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SAVE RESULT (NON-FATAL)
// ─────────────────────────────────────────────────────────────────────────────

async function saveCoverLetter(userId, payload, content) {
  try {
    const { data, error } = await supabase
      .from('cover_letters')
      .insert({
        user_id: userId,
        company_name: payload.companyName,
        job_title: payload.jobTitle,
        job_description: payload.jobDescription,
        tone: payload.tone ?? 'professional',
        content,
        created_at: new Date().toISOString(),
      })
      .select('id')
      .maybeSingle();

    if (error) throw error;

    logger.debug('[CoverLetterService] Saved', {
      userId,
      coverLetterId: data?.id,
    });

    return data?.id ?? null;
  } catch (error) {
    logger.warn('[CoverLetterService] Save failed (non-fatal)', {
      userId,
      error: error.message,
    });

    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ORCHESTRATOR
// ─────────────────────────────────────────────────────────────────────────────

async function generateCoverLetterForUser({
  userId,
  tier,
  planAmount,
  companyName,
  jobTitle,
  jobDescription,
  tone,
}) {
  const normalizedTier = String(tier ?? 'free')
    .trim()
    .toLowerCase();

  if (FREE_TIERS.has(normalizedTier)) {
    throw new AppError(
      'Cover letter generation is a Pro feature. Upgrade your plan to access it.',
      403,
      { upgradeUrl: process.env.UPGRADE_URL ?? '/pricing' },
      ErrorCodes.FORBIDDEN
    );
  }

  logger.debug('[CoverLetterService] Start', {
    userId,
    companyName,
    jobTitle,
    tone,
  });

  let creditsRemaining;
  let engineResult;
  let creditsDeducted = false;

  try {
    ({ creditsRemaining } = await deductCredits(userId, CREDIT_COST));
    creditsDeducted = true;

    engineResult = await generateCoverLetter({
      userId,
      companyName,
      jobTitle,
      jobDescription,
      tone,
    });
  } catch (error) {
    if (creditsDeducted) {
      await refundCredits(userId, CREDIT_COST);
    }

    throw error;
  }

  const coverLetterId = await saveCoverLetter(
    userId,
    { companyName, jobTitle, jobDescription, tone },
    engineResult.content
  );

  void logUsageAsync({
    userId,
    feature: FEATURE_ID,
    tier: normalizedTier,
    model: engineResult.model,
    inputTokens: engineResult.inputTokens,
    outputTokens: engineResult.outputTokens,
    planAmount: planAmount ?? null,
  });

  logger.debug('[CoverLetterService] Complete', {
    userId,
    coverLetterId,
    creditsRemaining,
  });

  return {
    content: engineResult.content,
    coverLetterId,
    creditsRemaining,
  };
}

module.exports = {
  generateCoverLetterForUser,
  CREDIT_COST,
  FEATURE_ID,
};