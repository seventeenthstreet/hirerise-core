'use strict';

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

const {
  CREDIT_COSTS,
} = require('./analysis.constants');

const VALID_OPERATIONS = new Set([
  'jobMatchAnalysis',
  'jobSpecificCV',
]);

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

async function saveJobMatchResult(
  userId,
  resumeId,
  operationType,
  result
) {
  try {
    const payload = {
      user_id: userId,
      resume_id: resumeId,
      operation_type: operationType,
      match_score:
        result.matchScore ??
        result.score ??
        null,
      job_title:
        result.jobTitle ??
        result.targetRole ??
        null,
      strengths: result.strengths ?? [],
      improvements: result.improvements ?? [],
      keywords_matched:
        result.keywordsMatched ?? [],
      recommendations:
        result.recommendations ?? [],
      analysis_payload: result,
      analyzed_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from('job_match_analyses')
      .insert(payload);

    if (error) throw error;
  } catch (error) {
    logger.error(
      '[JobMatchService] saveJobMatchResult failed',
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
        result.costUSD ??
        0,
      revenue_usd:
        result.revenueUSD ??
        0,
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

    const { error: deductError } =
      await supabase.rpc(
        'deduct_credits',
        {
          user_id: userId,
          amount: cost,
        }
      );

    if (deductError) {
      throw new AppError(
        'Credit deduction failed',
        500,
        {},
        ErrorCodes.INTERNAL_ERROR
      );
    }

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
      await supabase.rpc(
        'refund_credits',
        {
          user_id: userId,
          amount: cost,
        }
      );

      throw engineErr;
    }
  }

  await Promise.all([
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