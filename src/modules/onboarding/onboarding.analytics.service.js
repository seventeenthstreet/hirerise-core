'use strict';

const { supabase } = require('../../config/supabase');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const logger = require('../../utils/logger');
const {
  evaluateCompletion,
} = require('./onboarding.helpers');

// ─── SAFE CONSTANT FALLBACKS ──────────────────────────────────────────────────

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

// ─── CHI READY ────────────────────────────────────────────────────────────────

async function getChiReady(userId) {
  if (!userId) {
    throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);
  }

  try {
    const [progressRes, profileRes, chiRes] = await Promise.all([
      supabase.from('onboardingProgress').select('*').eq('id', userId).maybeSingle(),
      supabase.from('userProfiles').select('*').eq('id', userId).maybeSingle(),
      supabase
        .from('careerHealthIndex')
        .select('*')
        .eq('userId', userId)
        .eq('softDeleted', false)
        .order('generatedAt', { ascending: false })
        .limit(1),
    ]);

    if (progressRes.error) throw progressRes.error;
    if (profileRes.error) throw profileRes.error;
    if (chiRes.error) throw chiRes.error;

    const progress = progressRes.data || {};
    const profile  = profileRes.data  || {};

    const { score: dataCompleteness, missing } =
      computeChiCompleteness(progress, profile);

    const nudges = [...missing]
      .sort((a, b) => (b.improvementPts || 0) - (a.improvementPts || 0))
      .slice(0, 3);

    const chiRows = chiRes.data || [];

    if (chiRows.length === 0) {
      return { userId, isReady: false, latestChi: null, nudges, dataCompleteness };
    }

    const chiData = chiRows[0];

    if (chiData.analysisSource === 'teaser') {
      return { userId, isReady: false, latestChi: null, nudges, dataCompleteness };
    }

    return {
      userId,
      isReady: true,
      latestChi: {
        chiScore: chiData.chiScore,
        analysisSource: chiData.analysisSource,
        confidence: chiData.confidence || 'moderate',
        chiConfidence: chiData.chiConfidence,
        generatedAt: chiData.generatedAt ?? null,
        topStrength: chiData.topStrength || null,
        criticalGap: chiData.criticalGap || null,
        marketPosition: chiData.marketPosition || null,
      },
      nudges,
      dataCompleteness,
    };
  } catch (err) {
    logger.error('[OnboardingAnalytics] getChiReady failed', {
      userId,
      err: err?.message,
    });
    throw err;
  }
}

// ─── TEASER CHI ───────────────────────────────────────────────────────────────

async function getTeaserChi(jobFamilyId = null) {
  try {
    const target = jobFamilyId?.trim() || 'general';

    const { data, error } = await supabase
      .from('teaserChi')
      .select('*')
      .eq('id', target)
      .maybeSingle();

    if (error && error.code !== 'PGRST116') {
      logger.error('[DB] teaserChi.get', error.message);
    }

    if (data) return { ...data, analysisSource: 'teaser' };

    return TEASER_CHI_FALLBACK;
  } catch (err) {
    logger.error('[OnboardingAnalytics] getTeaserChi failed', { err: err.message });
    return TEASER_CHI_FALLBACK;
  }
}

// ─── CHI EXPLAINER ────────────────────────────────────────────────────────────

async function getChiExplainer(userId) {
  if (!userId) {
    throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);
  }

  try {
    const [progressRes, profileRes] = await Promise.all([
      supabase.from('onboardingProgress').select('*').eq('id', userId).maybeSingle(),
      supabase.from('userProfiles').select('*').eq('id', userId).maybeSingle(),
    ]);

    if (progressRes.error) throw progressRes.error;
    if (profileRes.error) throw profileRes.error;

    const progress = progressRes.data || {};
    const profile  = profileRes.data  || {};

    const { score, missing } = computeChiCompleteness(progress, profile);

    return {
      userId,
      dimensions: CHI_DIMENSION_DESCRIPTIONS,
      dataReadiness: {
        completenessScore: score,
        missingFields: missing,
        isReadyForChi: score >= 60,
      },
    };
  } catch (err) {
    logger.error('[OnboardingAnalytics] getChiExplainer failed', {
      userId,
      err: err?.message,
    });
    throw err;
  }
}

// ─── COMPLETENESS (SAFE) ──────────────────────────────────────────────────────

function computeChiCompleteness(progress = {}, profile = {}) {
  const checks = [
    [!!(profile.targetRoleId), 25],
    [!!profile.currentCity, 7],
    [!!profile.skills?.length, 25],
    [!!progress.education?.length, 8],
    [!!progress.experience?.length, 15],
  ];

  let score = 0;
  const missing = [];

  for (const [present, weight] of checks) {
    if (present) score += weight;
    else missing.push({ improvementPts: weight });
  }

  return {
    score: Math.min(100, score),
    missing: missing.slice(0, 3),
  };
}

// ─── FUNNEL ANALYTICS (CRITICAL FIXES) ─────────────────────────────────────────

async function getFunnelAnalytics({ limit = 500 } = {}) {
  try {
    const { data, error } = await supabase
      .from('onboardingProgress')
      .select('*')
      .limit(limit);

    if (error) throw error;

    const docs = data || [];

    let total = docs.length;
    const stepCounts = {
      completed: 0,
      career_report_generated: 0,
    };

    for (const d of docs) {
      if (!d) continue;

      if (d.careerReport) stepCounts.career_report_generated++;
      if (d.step === 'completed') stepCounts.completed++;
    }

    return {
      total,
      steps: stepCounts,
      scannedAt: new Date().toISOString(),
    };
  } catch (err) {
    logger.error('[OnboardingAnalytics] getFunnelAnalytics failed', {
      err: err?.message,
    });
    throw err;
  }
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  getChiReady,
  getTeaserChi,
  getChiExplainer,
  computeChiCompleteness,
  getFunnelAnalytics,
};
