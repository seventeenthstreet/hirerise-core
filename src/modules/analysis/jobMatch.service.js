'use strict';

/**
 * @file src/modules/analysis/jobMatch.service.js
 * @description
 * Wave 3 Priority #2 — Supabase RPC consolidation.
 *
 * Production hardening:
 * - centralized RPC execution
 * - deterministic credit deduction/refund
 * - normalized Supabase error handling
 * - safer premium rollback
 * - reduced write drift
 */

const { supabase } = require('../../config/supabase');
const {
  AppError,
  ErrorCodes,
} = require('../../middleware/errorHandler');
const logger = require('../../utils/logger');

const {
  runFreeEngine,
} = require('./jobMatchFreeEngine');

const {
  runFullAnalysis,
} = require('./jobMatchPremiumEngine');

const chiSnapshotsRepository = require('./repositories/chiSnapshots.repository');

const {
  CREDIT_COSTS,
} = require('./analysis.constants');

const VALID_OPERATIONS = new Set([
  'jobMatchAnalysis',
  'jobSpecificCV',
]);

const RPC = Object.freeze({
  DEDUCT_CREDITS: 'deduct_credits',
  REFUND_CREDITS: 'refund_credits',
});

// ─────────────────────────────────────────────────────────────
// Shared RPC executor
// ─────────────────────────────────────────────────────────────
async function executeRpc(fn, params = {}, { allowFallback = false } = {}) {
  const startedAt = Date.now();

  try {
    const { data, error } = await supabase.rpc(fn, params);

    if (error) {
      error.rpc = fn;
      throw error;
    }

    logger.debug('[JobMatchService][RPC] success', {
      rpc: fn,
      latency_ms: Date.now() - startedAt,
    });

    return data;
  } catch (error) {
    logger.warn('[JobMatchService][RPC] failed', {
      rpc: fn,
      latency_ms: Date.now() - startedAt,
      error: error?.message || 'Unknown RPC error',
      fallback_enabled: allowFallback,
    });

    if (!allowFallback) throw error;
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Data fetchers
// ─────────────────────────────────────────────────────────────
async function fetchResume(userId, resumeId) {
  const { data, error } = await supabase
    .from('resumes')
    .select(`
      id,
      user_id,
      resume_text,
      file_name,
      soft_deleted
    `)
    .eq('id', resumeId)
    .eq('user_id', userId)
    .eq('soft_deleted', false)
    .maybeSingle();

  if (error) {
    throw new AppError(
      'Resume fetch failed',
      500,
      { resumeId },
      ErrorCodes.INTERNAL_ERROR
    );
  }

  if (!data) {
    throw new AppError(
      'Resume not found',
      404,
      { resumeId },
      ErrorCodes.NOT_FOUND
    );
  }

  return data;
}

async function getUserCredits(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('id, ai_credits_remaining')
    .eq('id', userId)
    .maybeSingle();

  if (error || !data) {
    throw new AppError(
      'User not found',
      404,
      { userId },
      ErrorCodes.NOT_FOUND
    );
  }

  return data;
}

async function fetchCareerContext(userId) {
  try {
    const { data } = await supabase
      .from('user_profiles')
      .select(`
        target_role,
        current_job_title,
        skills,
        industry,
        experience_years
      `)
      .eq('id', userId)
      .maybeSingle();

    return data || null;
  } catch (error) {
    logger.warn(
      '[JobMatchService] career context unavailable',
      {
        userId,
        error: error.message,
      }
    );
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Persistence helpers
// ─────────────────────────────────────────────────────────────
async function saveJobMatchResult(
  userId,
  resumeId,
  operationType,
  result
) {
  try {
    const analysisHash = [
      userId,
      resumeId,
      operationType,
      result.matchScore ?? result.score ?? 'na',
    ].join(':');

    await chiSnapshotsRepository.createSnapshot({
      resumeId,
      userId,
      engine: result.engine || 'premium',
      analysisHash,
      score: result.matchScore ?? result.score ?? null,
      tier: result.tier ?? null,
      summary: result.summary ?? null,
      breakdown: result.breakdown ?? {
        matchScore: result.matchScore ?? null,
        recommendations: result.recommendations ?? [],
      },
      strengths: result.strengths ?? [],
      improvements: result.improvements ?? [],
      topSkills: result.keywordsMatched ?? [],
      chiScore:
        result.chiScore ??
        result.matchScore ??
        result.score ??
        null,
      dimensions: result.dimensions ?? null,
      marketPosition: result.marketPosition ?? null,
      peerComparison: result.peerComparison ?? null,
      growthInsights: result.growthInsights ?? null,
      salaryEstimate: result.salaryEstimate ?? null,
      roadmap:
        result.roadmap ??
        result.recommendations ??
        [],
      weightedCareerContext:
        result.weightedCareerContext ?? null,
      latencyMs: result.latencyMs ?? null,
      tokenInputCount:
        result.totalInputTokens ?? null,
      tokenOutputCount:
        result.totalOutputTokens ?? null,
      aiCostUsd: result.costUSD ?? null,
      operationType,
    });
  } catch (error) {
    logger.error(
      '[JobMatchService] CHI snapshot save failed',
      {
        userId,
        resumeId,
        error: error.message,
      }
    );
  }
}

async function logUsage(
  userId,
  operationType,
  tier,
  result
) {
  try {
    await supabase.from('usage_logs').insert({
      user_id: userId,
      feature: operationType,
      tier,
      model:
        result.engine ||
        'job-match-engine',
      total_tokens:
        result.totalTokens ?? 0,
      cost_usd:
        result.costUSD ?? 0,
      revenue_usd:
        result.revenueUSD ?? 0,
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    logger.warn(
      '[JobMatchService] usage log skipped',
      {
        userId,
        error: error.message,
      }
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Main execution
// ─────────────────────────────────────────────────────────────
async function runJobMatch({
  userId,
  resumeId,
  operationType,
  tier,
}) {
  if (!VALID_OPERATIONS.has(operationType)) {
    throw new AppError(
      'Invalid operationType',
      400,
      { operationType },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const costs = CREDIT_COSTS;
  const defaultCost = 2;

  const [resume, user, context] =
    await Promise.all([
      fetchResume(userId, resumeId),
      getUserCredits(userId),
      fetchCareerContext(userId),
    ]);

  let result;
  let creditsRemaining =
    user.ai_credits_remaining ?? 0;

  if (tier === 'free') {
    result = runFreeEngine({
      resumeId,
      resumeText: resume.resume_text,
      fileName: resume.file_name,
    });
  } else {
    const cost =
      costs[operationType] ??
      defaultCost;

    if (creditsRemaining < cost) {
      throw new AppError(
        'Insufficient credits',
        402,
        {
          required: cost,
          available: creditsRemaining,
        },
        ErrorCodes.PAYMENT_REQUIRED
      );
    }

    await executeRpc(
      RPC.DEDUCT_CREDITS,
      {
        user_id: userId,
        amount: cost,
      }
    );

    creditsRemaining -= cost;

    try {
      result = await runFullAnalysis({
        userId,
        userTier: tier,
        resumeId,
        resumeText: resume.resume_text,
        fileName: resume.file_name,
        weightedCareerContext: context,
      });
    } catch (engineErr) {
      try {
        await executeRpc(
          RPC.REFUND_CREDITS,
          {
            user_id: userId,
            amount: cost,
          }
        );
      } catch (refundErr) {
        logger.error(
          '[JobMatchService] refund failed after engine error',
          {
            userId,
            refund_error: refundErr.message,
          }
        );
      }

      throw engineErr;
    }
  }

  await Promise.allSettled([
    saveJobMatchResult(
      userId,
      resumeId,
      operationType,
      result
    ),
    logUsage(
      userId,
      operationType,
      tier,
      result
    ),
  ]);

  return {
    ...result,
    creditsRemaining,
  };
}

module.exports = {
  runJobMatch,
};