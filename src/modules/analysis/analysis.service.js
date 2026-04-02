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
const { getWeightedRoleContext } = require('../../services/career/careerWeight.service');

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
    weighted_career_context: result.weightedCareerContext ?? null,
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

async function runAnalysis({ userId, resumeId, operationType, tier }) {
  const { costs } = await creditConfigService.getCreditConfig();

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
  } else {
    if (operationType === 'fullAnalysis') {
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
  }

  await saveAnalysisResult(userId, resumeId, operationType, result);

  return result;
}

module.exports = { runAnalysis };