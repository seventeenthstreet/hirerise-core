'use strict';

/**
 * src/modules/coverLetter/coverLetter.service.js
 *
 * Wave 1 drift-safe AI credit transaction hardening
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

/**
 * Normalize scalar/object/array RPC responses
 */
function normalizeCreditResult(data) {
  if (data == null) {
    return 0;
  }

  if (typeof data === 'number') {
    return data;
  }

  const row = Array.isArray(data) ? data[0] : data;

  return Number(
    row?.remaining ??
    row?.remaining_credits ??
    row?.balance ??
    data ??
    0
  );
}

/**
 * Non-blocking usage logger
 */
async function logUsageAsync(payload) {
  try {
    await supabase.from('usage_logs').insert({
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

/**
 * Atomic deduct
 */
async function deductCredits(userId, amount) {
  const cost = Math.trunc(Number(amount));

  if (!Number.isFinite(cost) || cost <= 0) {
    throw new AppError(
      'Invalid credit cost configuration.',
      500,
      { amount },
      ErrorCodes.INTERNAL_SERVER_ERROR
    );
  }

  const { data, error } = await supabase.rpc('consume_ai_credits', {
    p_user_id: userId,
    p_cost: cost,
  });

  if (error) {
    const message = String(error.message || '');

    if (
      message.includes('INSUFFICIENT_CREDITS') ||
      error.code === 'P0001'
    ) {
      throw new AppError(
        'Insufficient AI credits. Please purchase a new plan.',
        402,
        { creditsRequired: cost },
        ErrorCodes.PAYMENT_REQUIRED
      );
    }

    throw new AppError(
      'Failed to deduct credits.',
      500,
      {
        rpc: 'consume_ai_credits',
        error: error.message,
      },
      ErrorCodes.DB_ERROR
    );
  }

  const creditsRemaining = normalizeCreditResult(data);

  logger.debug('[CoverLetterService] Credits deducted', {
    userId,
    cost,
    creditsRemaining,
  });

  return { creditsRemaining };
}

/**
 * Atomic refund (retry-safe per invocation)
 */
async function refundCredits(userId, amount, refundState) {
  if (refundState.refunded) {
    return;
  }

  refundState.refunded = true;

  try {
    const cost = Math.trunc(Number(amount));

    const { data, error } = await supabase.rpc('refund_ai_credits', {
      p_user_id: userId,
      p_cost: cost,
    });

    if (error) throw error;

    logger.debug('[CoverLetterService] Credits refunded', {
      userId,
      cost,
      creditsRemaining: normalizeCreditResult(data),
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

/**
 * Non-fatal persistence
 */
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

    return data?.id ?? null;
  } catch (error) {
    logger.warn('[CoverLetterService] Save failed (non-fatal)', {
      userId,
      error: error.message,
    });

    return null;
  }
}

/**
 * Main orchestrator
 */
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

  let creditsRemaining = null;
  let engineResult = null;
  const refundState = { refunded: false };

  try {
    ({ creditsRemaining } = await deductCredits(userId, CREDIT_COST));

    engineResult = await generateCoverLetter({
      userId,
      companyName,
      jobTitle,
      jobDescription,
      tone,
    });
  } catch (error) {
    await refundCredits(userId, CREDIT_COST, refundState);
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