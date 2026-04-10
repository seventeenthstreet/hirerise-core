'use strict';

const { supabase } = require('../../config/supabase');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const logger = require('../../utils/logger');

const { runFreeEngine } = require('./engines/freeEngine');
const {
  runFullAnalysis,
  runGenerateCV,
} = require('./engines/premiumEngine');

const creditConfigService = require('../../services/billing/creditConfig.service');
const {
  getWeightedRoleContext,
} = require('../../services/career/careerWeight.service');

const DEFAULT_CHI_LOOKBACK_DAYS = 45;
const DEFAULT_WEEKLY_ROLLUP_WEEKS = 12;

async function fetchCareerContext(userId) {
  try {
    const { data } = await supabase
      .from('user_profiles')
      .select('careerHistory,currentRoleId,previousRoleIds')
      .eq('id', userId)
      .maybeSingle();

    if (!data) return null;

    if (Array.isArray(data.careerHistory) && data.careerHistory.length) {
      return getWeightedRoleContext(data.careerHistory);
    }

    const legacyRoles = [];

    if (data.currentRoleId) {
      legacyRoles.push({
        roleId: data.currentRoleId,
        durationMonths: 1,
        isCurrent: true,
      });
    }

    for (const roleId of data.previousRoleIds || []) {
      legacyRoles.push({
        roleId,
        durationMonths: 1,
        isCurrent: false,
      });
    }

    return legacyRoles.length
      ? getWeightedRoleContext(legacyRoles)
      : null;
  } catch (error) {
    logger.warn('[AnalysisService] Career context fallback', {
      userId,
      error: error.message,
    });
    return null;
  }
}

async function fetchResume(userId, resumeId) {
  const { data, error } = await supabase
    .from('resumes')
    .select('id,user_id,resume_text,file_name,personal_details')
    .eq('id', resumeId)
    .maybeSingle();

  if (error || !data) {
    throw new AppError(
      'Resume not found',
      404,
      { resumeId },
      ErrorCodes.NOT_FOUND
    );
  }

  if (data.user_id !== userId) {
    throw new AppError(
      'Unauthorized',
      403,
      {},
      ErrorCodes.UNAUTHORIZED
    );
  }

  return data;
}

/**
 * Wave 3 #4.4
 * Partition-pruned latest CHI fast path.
 */
async function getLatestChiScore(
  userId,
  lookbackDays = DEFAULT_CHI_LOOKBACK_DAYS
) {
  const startedAt = Date.now();

  try {
    const { data, error } = await supabase.rpc(
      'get_latest_chi_score',
      {
        p_user_id: userId,
        p_lookback_days: lookbackDays,
      }
    );

    if (error) throw error;

    const latest = Array.isArray(data) ? data[0] || null : null;

    logger.debug('[AnalysisService] Latest CHI RPC success', {
      userId,
      lookbackDays,
      latency_ms: Date.now() - startedAt,
      found: Boolean(latest),
    });

    return latest;
  } catch (error) {
    logger.error('[AnalysisService] Latest CHI RPC failed', {
      userId,
      lookbackDays,
      latency_ms: Date.now() - startedAt,
      error: error.message,
    });

    return null;
  }
}

/**
 * Wave 3 #4.5
 * Partition-pruned CHI sparkline + trend history.
 */
async function getChiTrendHistory(
  userId,
  lookbackDays = DEFAULT_CHI_LOOKBACK_DAYS,
  bucket = 'day'
) {
  const startedAt = Date.now();

  try {
    const { data, error } = await supabase.rpc(
      'get_chi_trend_history',
      {
        p_user_id: userId,
        p_lookback_days: lookbackDays,
        p_bucket: bucket,
      }
    );

    if (error) throw error;

    const trend = Array.isArray(data) ? data : [];

    logger.debug('[AnalysisService] CHI trend RPC success', {
      userId,
      lookbackDays,
      bucket,
      points: trend.length,
      latency_ms: Date.now() - startedAt,
    });

    return trend;
  } catch (error) {
    logger.error('[AnalysisService] CHI trend RPC failed', {
      userId,
      lookbackDays,
      bucket,
      latency_ms: Date.now() - startedAt,
      error: error.message,
    });

    return [];
  }
}

/**
 * Wave 3 #4.6
 * Materialized weekly CHI BI rollups.
 */
async function getWeeklyChiRollups(
  userId,
  weeks = DEFAULT_WEEKLY_ROLLUP_WEEKS
) {
  const startedAt = Date.now();

  try {
    const { data, error } = await supabase
      .from('chi_weekly_rollups_mv')
      .select('*')
      .eq('user_id', userId)
      .order('week_bucket', { ascending: false })
      .limit(weeks);

    if (error) throw error;

    const rollups = Array.isArray(data) ? data : [];

    logger.debug('[AnalysisService] Weekly CHI rollups success', {
      userId,
      weeks,
      points: rollups.length,
      latency_ms: Date.now() - startedAt,
    });

    return rollups;
  } catch (error) {
    logger.error('[AnalysisService] Weekly CHI rollups failed', {
      userId,
      weeks,
      latency_ms: Date.now() - startedAt,
      error: error.message,
    });

    return [];
  }
}

async function saveAnalysisResult(userId, resumeId, operationType, result) {
  const payload = {
    user_id: userId,
    resume_id: resumeId,
    operation_type: operationType,
    engine: result.engine,
    analysis_hash: result.analysisHash ?? null,
    ai_model_version: result.aiModelVersion ?? null,
    score: result.score ?? null,
    tier: result.tier ?? null,
    summary: result.summary ?? null,
    breakdown: result.breakdown ?? null,
    strengths: result.strengths ?? [],
    improvements: result.improvements ?? [],
    top_skills: result.topSkills ?? [],
    estimated_experience_years:
      result.estimatedExperienceYears ?? null,
    chi_score: result.chiScore ?? null,
    dimensions: result.dimensions ?? null,
    market_position: result.marketPosition ?? null,
    peer_comparison: result.peerComparison ?? null,
    growth_insights: result.growthInsights ?? null,
    salary_estimate: result.salaryEstimate ?? null,
    roadmap: result.roadmap ?? null,
    weighted_career_context:
      result.weightedCareerContext ?? null,
    token_input_count: result.tokenInputCount ?? 0,
    token_output_count: result.tokenOutputCount ?? 0,
    ai_cost_usd: result.aiCostUsd ?? 0,
    latency_ms: result.latencyMs ?? null,
    cache_hit: result.cacheHit ?? false,
    cache_source: result.cacheSource ?? null,
  };

  const { error } = await supabase
    .from('resume_analyses')
    .upsert(payload, {
      onConflict: 'resume_id,analysis_hash,engine',
    });

  if (error) {
    logger.error('[AnalysisService] Save analysis failed', {
      resumeId,
      error: error.message,
    });
  }
}

async function runAnalysis({
  userId,
  resumeId,
  operationType,
  tier,
}) {
  await creditConfigService.getCreditConfig();

  const [resume, context] = await Promise.all([
    fetchResume(userId, resumeId),
    fetchCareerContext(userId),
  ]);

  let result;

  if (tier === 'free') {
    result = runFreeEngine({
      resumeId,
      resumeText: resume.resume_text,
      fileName: resume.file_name,
    });
  } else if (operationType === 'fullAnalysis') {
    result = await runFullAnalysis({
      userId,
      userTier: tier,
      resumeId,
      resumeText: resume.resume_text,
      fileName: resume.file_name,
      weightedCareerContext: context,
    });
  } else {
    result = await runGenerateCV(
      {
        userId,
        resumeText: resume.resume_text,
        fileName: resume.file_name,
        personalDetails: resume.personal_details ?? {},
      },
      {
        userTier: tier,
        userId,
      }
    );
  }

  await saveAnalysisResult(userId, resumeId, operationType, result);

  return result;
}

module.exports = {
  runAnalysis,
  getLatestChiScore,
  getChiTrendHistory,
  getWeeklyChiRollups,
};