'use strict';

/**
 * src/modules/onboarding/onboarding.analytics.js
 *
 * Production-ready Supabase analytics + CHI helpers.
 * Optimized for RPC-based funnel analytics at scale.
 *
 * TABLE REFERENCES (verified against Supabase schema):
 *   onboarding_progress   — snake_case (was: onboardingProgress in service)
 *   user_profiles         — snake_case (was: userProfiles in service)
 *   teaser_chi            — snake_case (was: teaserChi in service)
 *   career_health_index   — snake_case (was: careerHealthIndex in service)
 *
 * COLUMN REFERENCES (verified against onboarding_progress schema):
 *   updated_at            — snake_case (was: updatedAt)
 *   soft_deleted          — snake_case
 *   chi_status            — text column used for career_report_generated signal
 *
 * RPC FUNCTION:
 *   public.get_onboarding_funnel_analytics(p_limit, p_from, p_to)
 *   Returns: { total, steps: { completed, career_report_generated } }
 *
 * INDEX:
 *   idx_onboarding_progress_updated_step
 *   ON onboarding_progress (updated_at DESC, step)
 *   WHERE soft_deleted IS NOT TRUE
 */

const { supabase } = require('../../config/supabase');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const logger = require('../../utils/logger');

// ───────────────────────────────────────────────────────────────────────────────
// Table References
// Hardcoded after schema verification — all snake_case confirmed in Supabase
// ───────────────────────────────────────────────────────────────────────────────

const TABLE_ONBOARDING_PROGRESS = 'onboarding_progress';
const TABLE_USER_PROFILES        = 'user_profiles';
const TABLE_TEASER_CHI           = 'teaser_chi';
const TABLE_CAREER_HEALTH_INDEX  = 'career_health_index';

// ───────────────────────────────────────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────────────────────────────────────

const TEASER_CHI_FALLBACK = {
  chiScore:        65,
  marketPosition:  'average',
  topStrength:     'Foundational skills',
  criticalGap:     'Advanced specialization',
  analysisSource:  'teaser',
};

const CHI_DIMENSION_DESCRIPTIONS = [
  'Skills Strength',
  'Market Demand',
  'Experience Depth',
  'Role Alignment',
  'Growth Potential',
];

// ───────────────────────────────────────────────────────────────────────────────
// CHI Completeness
// ───────────────────────────────────────────────────────────────────────────────

function computeChiCompleteness(progress = {}, profile = {}) {
  const checks = [
    [Boolean(profile?.targetRoleId), 25, 'targetRoleId'],
    [Boolean(profile?.currentCity),   7, 'currentCity'],
    [Boolean(profile?.skills?.length), 25, 'skills'],
    [Boolean(progress?.education?.length), 8, 'education'],
    [Boolean(progress?.experience?.length), 15, 'experience'],
  ];

  let score = 0;
  const missing = [];

  for (const [present, weight, field] of checks) {
    if (present) {
      score += weight;
    } else {
      missing.push({ field, improvementPts: weight });
    }
  }

  return {
    score:   Math.min(100, score),
    missing: missing
      .sort((a, b) => b.improvementPts - a.improvementPts)
      .slice(0, 3),
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// getChiReady
// ───────────────────────────────────────────────────────────────────────────────

async function getChiReady(userId) {
  if (!userId) {
    throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);
  }

  try {
    const [progressRes, profileRes, chiRes] = await Promise.all([
      supabase
        .from(TABLE_ONBOARDING_PROGRESS)
        .select('*')
        .eq('id', userId)
        .maybeSingle(),

      supabase
        .from(TABLE_USER_PROFILES)
        .select('*')
        .eq('id', userId)
        .maybeSingle(),

      supabase
        .from(TABLE_CAREER_HEALTH_INDEX)
        .select('chiScore, analysisSource, confidence, chiConfidence, generatedAt, topStrength, criticalGap, marketPosition')
        .eq('userId', userId)
        .eq('softDeleted', false)
        .order('generatedAt', { ascending: false })
        .limit(1),
    ]);

    if (progressRes.error) throw progressRes.error;
    if (profileRes.error)  throw profileRes.error;
    if (chiRes.error)      throw chiRes.error;

    const progress = progressRes.data || {};
    const profile  = profileRes.data  || {};
    const { score: dataCompleteness, missing } = computeChiCompleteness(progress, profile);
    const chiData = chiRes.data?.[0];

    if (!chiData || chiData.analysisSource === 'teaser') {
      return {
        userId,
        isReady:          false,
        latestChi:        null,
        nudges:           missing,
        dataCompleteness,
      };
    }

    return {
      userId,
      isReady:   true,
      latestChi: {
        ...chiData,
        confidence: chiData.confidence || 'moderate',
      },
      nudges:           missing,
      dataCompleteness,
    };
  } catch (err) {
    logger.error('[OnboardingAnalytics] getChiReady failed', {
      userId,
      table: TABLE_CAREER_HEALTH_INDEX,
      err: err.message,
    });
    throw err;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// getTeaserChi
// ───────────────────────────────────────────────────────────────────────────────

async function getTeaserChi(jobFamilyId = null) {
  try {
    const target = String(jobFamilyId || '').trim() || 'general';

    const { data, error } = await supabase
      .from(TABLE_TEASER_CHI)
      .select('chiScore, marketPosition, topStrength, criticalGap')
      .eq('id', target)
      .maybeSingle();

    if (error && error.code !== 'PGRST116') {
      throw error;
    }

    return data
      ? { ...data, analysisSource: 'teaser' }
      : TEASER_CHI_FALLBACK;
  } catch (err) {
    logger.warn('[OnboardingAnalytics] getTeaserChi fallback', {
      table: TABLE_TEASER_CHI,
      err: err.message,
    });
    return TEASER_CHI_FALLBACK;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// getChiExplainer
// ───────────────────────────────────────────────────────────────────────────────

async function getChiExplainer(userId) {
  if (!userId) {
    throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);
  }

  const [progressRes, profileRes] = await Promise.all([
    supabase
      .from(TABLE_ONBOARDING_PROGRESS)
      .select('education, experience')
      .eq('id', userId)
      .maybeSingle(),

    supabase
      .from(TABLE_USER_PROFILES)
      .select('targetRoleId, currentCity, skills')
      .eq('id', userId)
      .maybeSingle(),
  ]);

  if (progressRes.error) throw progressRes.error;
  if (profileRes.error)  throw profileRes.error;

  const { score, missing } = computeChiCompleteness(
    progressRes.data || {},
    profileRes.data  || {}
  );

  return {
    userId,
    dimensions:   CHI_DIMENSION_DESCRIPTIONS,
    dataReadiness: {
      completenessScore: score,
      missingFields:     missing,
      isReadyForChi:     score >= 60,
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// getFunnelAnalytics
//
// Delegates aggregation to public.get_onboarding_funnel_analytics RPC.
// Avoids Node.js row scanning — all counting done in PostgreSQL.
//
// Backed by:
//   idx_onboarding_progress_updated_step
//   ON onboarding_progress (updated_at DESC, step)
//   WHERE soft_deleted IS NOT TRUE
// ───────────────────────────────────────────────────────────────────────────────

async function getFunnelAnalytics({
  limit    = 500,
  fromDate = null,
  toDate   = null,
} = {}) {
  try {
    const { data, error } = await supabase.rpc(
      'get_onboarding_funnel_analytics',
      {
        p_limit: Math.min(limit, 5000),
        p_from:  fromDate ? new Date(fromDate).toISOString() : null,
        p_to:    toDate   ? new Date(toDate).toISOString()   : null,
      }
    );

    if (error) throw error;

    return {
      total:      data?.total  || 0,
      steps:      data?.steps  || {},
      scannedAt:  new Date().toISOString(),
    };
  } catch (err) {
    logger.error('[OnboardingAnalytics] getFunnelAnalytics failed', {
      rpc:  'get_onboarding_funnel_analytics',
      err:  err.message,
    });
    throw err;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Exports
// ───────────────────────────────────────────────────────────────────────────────

module.exports = {
  getChiReady,
  getTeaserChi,
  getChiExplainer,
  computeChiCompleteness,
  getFunnelAnalytics,
};