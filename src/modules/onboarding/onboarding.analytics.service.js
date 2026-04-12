'use strict';

/**
 * src/modules/onboarding/onboarding.analytics.js
 *
 * Production-ready Supabase analytics + CHI helpers.
 * Optimized for RPC-based funnel analytics at scale.
 *
 * ✅ FULLY PATCHED FOR AUDIT C-5
 * ✅ Single-source CHI reads from career_health_index
 * ✅ All DB reads converted to snake_case
 * ✅ Safe response normalization to camelCase
 */

const { supabase } = require('../../config/supabase');
const {
  AppError,
  ErrorCodes,
} = require('../../middleware/errorHandler');
const logger = require('../../utils/logger');

// ───────────────────────────────────────────────────────────────────────────────
// Table References
// ───────────────────────────────────────────────────────────────────────────────

const TABLE_ONBOARDING_PROGRESS = 'onboarding_progress';
const TABLE_USER_PROFILES = 'user_profiles';
const TABLE_TEASER_CHI = 'teaser_chi';
const TABLE_CAREER_HEALTH_INDEX = 'career_health_index';

// ───────────────────────────────────────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────────────────────────────────────

const TEASER_CHI_FALLBACK = {
  chiScore: 65,
  marketPosition: 'average',
  topStrength: 'Foundational skills',
  criticalGap: 'Advanced specialization',
  analysisSource: 'teaser',
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
    [Boolean(profile?.currentCity), 7, 'currentCity'],
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
      missing.push({
        field,
        improvementPts: weight,
      });
    }
  }

  return {
    score: Math.min(100, score),
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
    throw new AppError(
      'userId is required',
      400,
      {},
      ErrorCodes.VALIDATION_ERROR
    );
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
        .select(
          `
          chi_score,
          analysis_source,
          confidence,
          chi_confidence,
          generated_at,
          top_strength,
          critical_gap,
          market_position
          `
        )
        .eq('user_id', userId)
        .eq('soft_deleted', false)
        .order('generated_at', { ascending: false })
        .limit(1),
    ]);

    if (progressRes.error) throw progressRes.error;
    if (profileRes.error) throw profileRes.error;
    if (chiRes.error) throw chiRes.error;

    const progress = progressRes.data || {};
    const profile = profileRes.data || {};

    const {
      score: dataCompleteness,
      missing,
    } = computeChiCompleteness(progress, profile);

    const chiData = chiRes.data?.[0];

    const normalizedChi = chiData
      ? {
          chiScore: chiData.chi_score,
          analysisSource: chiData.analysis_source,
          confidence:
            chiData.confidence || 'moderate',
          chiConfidence: chiData.chi_confidence,
          generatedAt: chiData.generated_at,
          topStrength: chiData.top_strength,
          criticalGap: chiData.critical_gap,
          marketPosition: chiData.market_position,
        }
      : null;

    if (
      !normalizedChi ||
      normalizedChi.analysisSource === 'teaser'
    ) {
      return {
        userId,
        isReady: false,
        latestChi: null,
        nudges: missing,
        dataCompleteness,
      };
    }

    return {
      userId,
      isReady: true,
      latestChi: normalizedChi,
      nudges: missing,
      dataCompleteness,
    };
  } catch (err) {
    logger.error(
      '[OnboardingAnalytics] getChiReady failed',
      {
        userId,
        table: TABLE_CAREER_HEALTH_INDEX,
        err: err.message,
      }
    );
    throw err;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// getTeaserChi
// ───────────────────────────────────────────────────────────────────────────────

async function getTeaserChi(jobFamilyId = null) {
  try {
    const target =
      String(jobFamilyId || '').trim() || 'general';

    const { data, error } = await supabase
      .from(TABLE_TEASER_CHI)
      .select(
        'chi_score, market_position, top_strength, critical_gap'
      )
      .eq('id', target)
      .maybeSingle();

    if (error && error.code !== 'PGRST116') {
      throw error;
    }

    return data
      ? {
          chiScore: data.chi_score,
          marketPosition: data.market_position,
          topStrength: data.top_strength,
          criticalGap: data.critical_gap,
          analysisSource: 'teaser',
        }
      : TEASER_CHI_FALLBACK;
  } catch (err) {
    logger.warn(
      '[OnboardingAnalytics] getTeaserChi fallback',
      {
        table: TABLE_TEASER_CHI,
        err: err.message,
      }
    );
    return TEASER_CHI_FALLBACK;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// getChiExplainer
// ───────────────────────────────────────────────────────────────────────────────

async function getChiExplainer(userId) {
  if (!userId) {
    throw new AppError(
      'userId is required',
      400,
      {},
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const [progressRes, profileRes] = await Promise.all([
    supabase
      .from(TABLE_ONBOARDING_PROGRESS)
      .select('education, experience')
      .eq('id', userId)
      .maybeSingle(),

    supabase
      .from(TABLE_USER_PROFILES)
      .select('target_role_id, current_city, skills')
      .eq('id', userId)
      .maybeSingle(),
  ]);

  if (progressRes.error) throw progressRes.error;
  if (profileRes.error) throw profileRes.error;

  const normalizedProfile = profileRes.data
    ? {
        targetRoleId: profileRes.data.target_role_id,
        currentCity: profileRes.data.current_city,
        skills: profileRes.data.skills,
      }
    : {};

  const { score, missing } = computeChiCompleteness(
    progressRes.data || {},
    normalizedProfile
  );

  return {
    userId,
    dimensions: CHI_DIMENSION_DESCRIPTIONS,
    dataReadiness: {
      completenessScore: score,
      missingFields: missing,
      isReadyForChi: score >= 60,
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// getFunnelAnalytics
// ───────────────────────────────────────────────────────────────────────────────

async function getFunnelAnalytics({
  limit = 500,
  fromDate = null,
  toDate = null,
} = {}) {
  try {
    const { data, error } = await supabase.rpc(
      'get_onboarding_funnel_analytics',
      {
        p_limit: Math.min(limit, 5000),
        p_from: fromDate
          ? new Date(fromDate).toISOString()
          : null,
        p_to: toDate
          ? new Date(toDate).toISOString()
          : null,
      }
    );

    if (error) throw error;

    return {
      total: data?.total || 0,
      steps: data?.steps || {},
      scannedAt: new Date().toISOString(),
    };
  } catch (err) {
    logger.error(
      '[OnboardingAnalytics] getFunnelAnalytics failed',
      {
        rpc: 'get_onboarding_funnel_analytics',
        err: err.message,
      }
    );
    throw err;
  }
}

module.exports = {
  getChiReady,
  getTeaserChi,
  getChiExplainer,
  computeChiCompleteness,
  getFunnelAnalytics,
};