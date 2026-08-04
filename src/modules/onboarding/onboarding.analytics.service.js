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

// WP-PRO-08: Professional Onboarding Definition Engine. getProgress()
// no longer hardcodes step logic — steps[] and currentStep are derived
// from the canonical definition (professional-onboarding.definition.js)
// via these pure helpers. Analytics remains a *consumer* of the
// definition, never an owner of it (WP-PRO-02B §3, Option D rejected).
const {
  buildSteps,
  computeCurrentStep,
} = require('./professional-onboarding.progression');

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

// ───────────────────────────────────────────────────────────────────────────────
// getProgress
// Returns the current onboarding step, completed steps history, and whether
// onboarding is fully completed.  Used by the frontend init() on page load to
// restore progress for returning users.
// ───────────────────────────────────────────────────────────────────────────────

async function getProgress(userId) {
  if (!userId) {
    throw new AppError(
      'userId is required',
      400,
      {},
      ErrorCodes.VALIDATION_ERROR
    );
  }

  try {
    // Read all three tables in parallel — same pattern used by getChiReady.
    // WP-PRO-08: the column list and the added user_profiles read exist
    // solely to feed the definition engine's step-completion derivation
    // (professional-onboarding.progression.js#isStepComplete) and the
    // existing, unchanged evaluateCompletion() (onboarding.helpers.js) —
    // every one of these columns is already read by evaluateCompletion or
    // by uploadCvDuringOnboarding elsewhere in this module; none is new.
    const [progressRes, usersRes, profileRes] = await Promise.all([
      supabase
        .from(TABLE_ONBOARDING_PROGRESS)
        // completed_at does not exist — use onboarding_completed_at
        .select(
          'step, step_history, onboarding_completed_at, updated_at, ' +
          'confidence, cv_resume_id, personal_details, full_name, ' +
          'education, experience, career_report'
        )
        .eq('id', userId)
        .maybeSingle(),

      supabase
        .from('users')
        // onboarding_completed_at does not exist on users table
        .select('onboarding_completed')
        .eq('id', userId)
        .maybeSingle(),

      supabase
        .from(TABLE_USER_PROFILES)
        // WP-AV-03C: display_name added. computeStepStates() below feeds
        // this row straight into the same evaluateCompletion() used by
        // persistCompletionIfReady() (WP-AV-03C primary fix), which now
        // reads profile.display_name for trackAUpload. Without it here,
        // GET /progress would keep showing Resume-Upload users as
        // incomplete even though their real completion state (persisted
        // via the controller's separate select('*') read) is correct —
        // a display/consistency defect in this endpoint only, not the
        // Dashboard-entry gate (that reads `users.onboarding_completed`
        // directly; see appEntry.route.js). No other column changed.
        .select('career_history, expected_role_ids, display_name')
        .eq('id', userId)
        .maybeSingle(),
    ]);

    if (progressRes.error) throw progressRes.error;

    const progress = progressRes.data;
    const user     = usersRes.data;
    const profile  = profileRes.data || {};

    // New user — no progress row yet.  Return a safe empty default so the
    // frontend can start fresh without treating this as an error.
    //
    // WP-PRO-08: this branch previously returned completedSteps: [] with
    // no steps[]/currentStep at all — the direct cause of the "0 of 0
    // steps" defect. It now routes through the same buildSteps()/
    // computeCurrentStep() helpers as the populated-row branch below, so
    // the "no progress row" and "has progress row" paths can never drift
    // from each other (WP-PRO-03A §3 boundary requirement).
    if (!progress) {
      const { isComplete, steps } = buildSteps({
        completedSteps: [],
        progress:       {},
        profile,
      });

      return {
        userId,
        step:               null,
        completedSteps:     [],
        onboardingCompleted: user?.onboarding_completed ?? isComplete ?? false,
        steps,
        currentStep:        computeCurrentStep(steps),
        // WP-PRO-08: OnboardingProgressResponse (features/onboarding/types)
        // declares isComplete but no code path populated it before this WP.
        isComplete,
      };
    }

    const stepHistory = Array.isArray(progress.step_history)
      ? progress.step_history.map((h) => (typeof h === 'string' ? h : h?.step)).filter(Boolean)
      : [];

    const { isComplete, steps } = buildSteps({
      completedSteps: stepHistory,
      progress,
      profile,
    });

    return {
      userId,
      step:               progress.step ?? null,
      completedSteps:     stepHistory,
      onboardingCompleted: user?.onboarding_completed ?? (progress.step === 'completed' || isComplete),
      completedAt:        progress.onboarding_completed_at ?? null,
      updatedAt:          progress.updated_at ?? null,
      // WP-PRO-08: additive fields — Progress API Contract (WP-PRO-03A §4).
      // `step` is retained unchanged above for any undiscovered consumer;
      // `currentStep` is the correct field name the frontend's
      // hooks/useOnboarding.ts selector already reads
      // (raw.currentStep ?? raw.steps?.[0]?.stepId ?? null).
      steps,
      currentStep: computeCurrentStep(steps),
      // WP-PRO-08: OnboardingProgressResponse (features/onboarding/types)
      // declares isComplete but no code path populated it before this WP.
      isComplete,
    };
  } catch (err) {
    logger.error('[OnboardingAnalytics] getProgress failed', {
      userId,
      err: err.message,
    });
    throw err;
  }
}

module.exports = {
  getProgress,
  getChiReady,
  getTeaserChi,
  getChiExplainer,
  computeChiCompleteness,
  getFunnelAnalytics,
};