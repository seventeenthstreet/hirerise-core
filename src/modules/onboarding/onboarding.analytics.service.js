'use strict';

/**
 * onboarding.analytics.service.js — B-01 FIX: Analytics + progress sub-service
 *
 * Extracted from onboarding.service.js (god-object decomposition).
 * Owns: getProgress, getChiReady, getTeaserChi, getChiExplainer,
 *       computeChiCompleteness, getFunnelAnalytics
 *
 * MIGRATED: All Firestore db.collection() calls replaced with supabase.from()
 * FieldValue.serverTimestamp() → new Date().toISOString()
 * snap.exists / snap.data()   → Supabase { data, error } destructuring
 * snap.docs / snap.empty      → plain data arrays
 */

const supabase = require('../../config/supabase');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const logger = require('../../utils/logger');
const {
  buildAIContext,
  evaluateCompletion,
  inferRegion,
  CHI_TREND_THRESHOLD,
} = require('./onboarding.helpers');

async function getChiReady(userId) {
  if (!userId) throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);

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

  const progress = progressRes.data || {};
  const profile  = profileRes.data  || {};

  // CHI completeness nudges — sorted by impact, capped at 3
  const { score: dataCompleteness, missing } = computeChiCompleteness(progress, profile);
  const nudges = [...missing]
    .sort((a, b) => (b.improvementPts || 0) - (a.improvementPts || 0))
    .slice(0, 3);

  const chiRows = chiRes.data || [];

  // No CHI at all
  if (chiRows.length === 0) {
    return { userId, isReady: false, latestChi: null, nudges, dataCompleteness };
  }

  const chiData = chiRows[0];

  // Teaser source is never the user's own score
  if (chiData.analysisSource === 'teaser') {
    return { userId, isReady: false, latestChi: null, nudges, dataCompleteness };
  }

  return {
    userId,
    isReady: true,
    latestChi: {
      chiScore:        chiData.chiScore,
      analysisSource:  chiData.analysisSource,
      confidence:      chiData.confidence || 'moderate',
      chiConfidence:   chiData.chiConfidence,
      generatedAt:     chiData.generatedAt ?? null,
      topStrength:     chiData.topStrength  || null,
      criticalGap:     chiData.criticalGap  || null,
      marketPosition:  chiData.marketPosition || null,
    },
    nudges,
    dataCompleteness,
  };
}

async function getTeaserChi(jobFamilyId = null) {
  try {
    const targetFamily = jobFamilyId ? String(jobFamilyId).trim() : 'general';

    const { data: teaserRow, error: teaserErr } = await supabase
      .from('teaserChi')
      .select('*')
      .eq('id', targetFamily)
      .maybeSingle();
    if (teaserErr && teaserErr.code !== 'PGRST116') {
      logger.error('[DB] teaserChi.get:', teaserErr.message);
    }

    if (teaserRow) {
      return { ...teaserRow, analysisSource: 'teaser' };
    }

    if (targetFamily !== 'general') {
      const { data: generalRow, error: generalErr } = await supabase
        .from('teaserChi')
        .select('*')
        .eq('id', 'general')
        .maybeSingle();
      if (generalErr && generalErr.code !== 'PGRST116') {
        logger.error('[DB] teaserChi.get:', generalErr.message);
      }
      if (generalRow) return { ...generalRow, analysisSource: 'teaser' };
    }

    logger.warn('[OnboardingService] teaserChi collection not seeded — returning fallback');
    return TEASER_CHI_FALLBACK;
  } catch (err) {
    logger.error('[OnboardingService] getTeaserChi failed — returning fallback', { error: err.message });
    return TEASER_CHI_FALLBACK;
  }
}

async function getChiExplainer(userId) {
  if (!userId) throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);

  const [progressRes, profileRes] = await Promise.all([
    supabase.from('onboardingProgress').select('*').eq('id', userId).maybeSingle(),
    supabase.from('userProfiles').select('*').eq('id', userId).maybeSingle(),
  ]);

  const progress = progressRes.data || {};
  const profile  = profileRes.data  || {};

  // Reuse the existing completeness scorer so nudges are always in sync
  const { score, missing } = computeChiCompleteness(progress, profile);

  // Surface any existing CHI score so the frontend can show "your last score was X"
  let lastScore = null;
  try {
    const { data: chiRows, error: chiErr } = await supabase
      .from('careerHealthIndex')
      .select('chiScore, analysisSource, marketPosition, generatedAt')
      .eq('userId', userId)
      .eq('softDeleted', false)
      .order('generatedAt', { ascending: false })
      .limit(1);

    if (!chiErr && chiRows && chiRows.length > 0) {
      const d = chiRows[0];
      lastScore = {
        chiScore:       d.chiScore,
        analysisSource: d.analysisSource,
        marketPosition: d.marketPosition,
        generatedAt:    d.generatedAt ?? null,
      };
    }
  } catch {
    // Non-fatal — explainer still works without last score
  }

  return {
    userId,
    dimensions: CHI_DIMENSION_DESCRIPTIONS,
    scoringModel: {
      totalDimensions: 5,
      scoreRange: '0–100',
      bands: [
        { min: 85, label: 'Highly Ready' },
        { min: 70, label: 'Ready' },
        { min: 55, label: 'Moderately Ready' },
        { min: 40, label: 'Partially Ready' },
        { min: 0,  label: 'Not Ready' },
      ],
    },
    dataReadiness: {
      completenessScore: score,
      missingFields:     missing,
      isReadyForChi:     score >= 60,
      message: score >= 60
        ? 'Your profile has enough data for a reliable Career Health Score.'
        : `Complete ${missing.length} more field${missing.length !== 1 ? 's' : ''} to unlock a reliable score.`,
    },
    lastScore,
  };
}

function computeChiCompleteness(progress, profile) {
  const checks = [
    // [field present?, weight, label, nudge message]
    // Weights mirror the actual CHI scoring weights.
    // SPRINT-1 C1: targetRoleId replaces free-text targetRole
    [!!(profile.expectedRoleIds?.length || profile.targetRoleId), 25, 'Target Roles',
      'Add your target role — required for market alignment and salary benchmarking'],
    // P1-03: salary is optional; mark present if value exists, salaryDeclined=true, or legacy -1 sentinel
    [profile.currentSalaryLPA !== null && profile.currentSalaryLPA !== undefined ||
     profile.salaryDeclined === true ||
     profile.currentSalaryLPA === -1,
     15, 'Current Salary',
     'Add your current salary for salary benchmarking (+15 pts) — or select "prefer not to say"'],
    [!!profile.currentCity,          7,  'Location',        'Add your current city'],
    [!!profile.skills?.length,       25, 'Skills',          'Add your skills with proficiency levels'],
    [!!progress.education?.length,   8,  'Education',       'Add education history'],
    [!!progress.experience?.length,  15, 'Work Experience', 'Add work experience'],
    [!!profile.totalExperienceYears, 5,  'Tenure',          'Add dates to your experience entries'],
    // SPRINT-1 C5: seniority nudge — improves peerComparison accuracy (weight=0, informational)
    [!!profile.selfDeclaredSeniority, -0, 'Seniority Level',
      'Add your seniority level for accurate peer benchmarking'],
  ];

  let score = 0;
  const missing = [];

  for (const [present, weight, label, nudge] of checks) {
    if (weight > 0) {
      if (present) {
        score += weight;
      } else {
        missing.push({
          field:          label,
          nudge,
          improvementPts: weight,
          impact: weight >= 20 ? 'HIGH' : weight >= 10 ? 'MEDIUM' : 'LOW',
        });
      }
    } else if (!present && progress.experience?.length) {
      missing.push({ field: label, nudge, improvementPts: 0, impact: 'LOW' });
    }
  }

  // P1-11: Sort by improvementPts descending — cap at 3
  missing.sort((a, b) => b.improvementPts - a.improvementPts);
  const topMissing = missing.slice(0, 3);

  return { score: Math.min(100, score), missing: topMissing };
}

async function getProgress(userId, tier) {
  if (!userId) throw new AppError('userId is required', 400, {}, ErrorCodes.VALIDATION_ERROR);

  const [progressRes, profileRes, remainingQuota] = await Promise.all([
    supabase.from('onboardingProgress').select('*').eq('id', userId).maybeSingle(),
    supabase.from('userProfiles').select('*').eq('id', userId).maybeSingle(),
    tier === 'free'
      ? getRemainingQuota(userId, 'free').catch(() => null)
      : Promise.resolve(null),
  ]);

  const upgradeUrl = process.env.UPGRADE_URL ?? '/pricing';
  let quotaExhausted = null;
  if (tier === 'free' && remainingQuota) {
    quotaExhausted = {
      careerReport: (remainingQuota.careerReport ?? 1) <= 0,
      generateCV:   (remainingQuota.generateCV   ?? 1) <= 0,
      upgradeUrl,
    };
  }

  if (!progressRes.data) {
    return {
      userId,
      step:             'not_started',
      nextRequiredStep: 'education_experience',
      data:             null,
      remainingQuota,
      quotaExhausted,
      progressPercent:  0,
      totalSteps:       4,
      completedSteps:   0,
    };
  }

  const progress = progressRes.data;
  const profile  = profileRes.data || {};

  const { isComplete, trackA, trackB } = evaluateCompletion(progress, profile);

  // GAP-05: CHI data completeness nudge signal
  const chiCompleteness = computeChiCompleteness(progress, profile);

  // GAP F2 / P1-08: next required step — updated for two-phase model
  let nextRequiredStep = null;
  if (!progress.quickStartCompleted && !progress.education?.length && !progress.experience?.length) {
    nextRequiredStep = 'quick_start';
  } else if (!progress.careerReport) {
    nextRequiredStep = 'career_report';
  }

  // GAP F7: progress percentage
  let completedSteps = 0;
  if (progress.education?.length || progress.experience?.length) completedSteps++;
  if (progress.careerReport) completedSteps++;
  if (isComplete) completedSteps++;
  const totalSteps     = 3;
  const progressPercent = Math.round((Math.min(completedSteps, totalSteps) / totalSteps) * 100);

  // GAP-H10 / P1-08: Structured steps array — updated for two-phase onboarding model.
  const hasQuickStart              = !!progress.quickStartCompleted;
  const hasEducationOrExperience   = !!(progress.education?.length || progress.experience?.length);
  const hasCareerReport            = !!progress.careerReport;
  const hasPersonalDetails         = !!progress.personalDetails?.fullName;
  const hasCv                      = !!(progress.cvResumeId || progress.step === 'completed_without_cv');

  const steps = [
    {
      stepId:                 'quick_start',
      label:                  'Quick Start',
      isRequired:             true,
      isComplete:             hasQuickStart || hasEducationOrExperience,
      isCurrent:              !hasQuickStart && !hasEducationOrExperience,
      estimatedTimeMinutes:   2,
      description:            'Job title, target role, and a few skills — takes 2 minutes',
    },
    {
      stepId:                 'career_report',
      label:                  'Career Report',
      isRequired:             true,
      isComplete:             hasCareerReport,
      isCurrent:              (hasQuickStart || hasEducationOrExperience) && !hasCareerReport,
      estimatedTimeMinutes:   1,
      description:            'AI generates your personalised career intelligence report',
    },
    {
      stepId:                 'enrich_profile',
      label:                  'Enrich Profile',
      isRequired:             false,
      isComplete:             hasEducationOrExperience,
      isCurrent:              hasCareerReport && !hasEducationOrExperience,
      estimatedTimeMinutes:   5,
      description:            'Add full experience, education, and salary for a more accurate score',
    },
    {
      stepId:                 'personal_details',
      label:                  'Personal Details',
      isRequired:             false,
      isComplete:             hasPersonalDetails,
      isCurrent:              hasCareerReport && hasEducationOrExperience && !hasPersonalDetails,
      estimatedTimeMinutes:   2,
      description:            'Name, contact info, and location for your CV',
    },
    {
      stepId:                 'generate_cv',
      label:                  'Generate CV',
      isRequired:             false,
      isComplete:             hasCv,
      isCurrent:              hasPersonalDetails && !hasCv,
      estimatedTimeMinutes:   1,
      description:            'AI builds your professional CV from your profile',
    },
  ];

  return {
    userId,
    step:               progress.step,
    onboardingCompleted: profile.onboardingCompleted === true,
    tracks:             { trackA, trackB, isComplete },
    steps,
    stepHistory:        progress.stepHistory || [],
    onboardingStartedAt:    progress.onboardingStartedAt    || null,
    onboardingCompletedAt:  profile.onboardingCompletedAt   || null,
    remainingQuota,
    quotaExhausted,
    previousCvIds:      progress.previousCvIds || [],
    nextRequiredStep,
    progressPercent,
    totalSteps,
    completedSteps,
    chiDataCompleteness: chiCompleteness.score,
    chiDataMissing:      chiCompleteness.missing,
    draft:               progress.draft        || null,
    draftVersion:        progress.draftVersion ?? 0,
    stepData: (() => {
      if (!hasQuickStart && !hasEducationOrExperience) {
        return progress.importedProfile
          ? { source: 'linkedin_import', importedProfile: progress.importedProfile, importSource: progress.importSource || null }
          : { source: 'empty', importSource: progress.importSource || null };
      }
      if (!hasCareerReport) {
        return {
          source:          'onboarding_data',
          educationCount:  (progress.education  || []).length,
          experienceCount: (progress.experience || []).length,
          skillsCount:     (profile.skills      || []).length,
          quickStartCompleted: !!progress.quickStartCompleted,
        };
      }
      if (!hasPersonalDetails && hasCareerReport) {
        return {
          source:   'partial',
          fullName: progress.personalDetails?.fullName || null,
          email:    progress.personalDetails?.email    || null,
          phone:    progress.personalDetails?.phone    || null,
        };
      }
      if (!hasCv && hasPersonalDetails) {
        return {
          source:        'cv_step',
          hasCvDraft:    !!progress.cvDraft,
          cvDraftSavedAt: progress.cvDraft?.savedAt || null,
        };
      }
      return null;
    })(),
    importSource: progress.importSource || null,
    data:         progress,
  };
}

async function getFunnelAnalytics({
  limit    = 500,
  after    = null,
  fromDate = null,
  toDate   = null,
} = {}) {
  // B-06 FIX: bounded date-range query prevents full-collection scan at >10k users.
  let query = supabase
    .from('onboardingProgress')
    .select('*')
    .order('onboardingStartedAt', { ascending: false })
    .limit(limit);

  if (fromDate) query = query.gte('onboardingStartedAt', fromDate);
  if (toDate)   query = query.lte('onboardingStartedAt', toDate);

  // Cursor-based pagination: if `after` is supplied, use keyset pagination
  // by fetching the cursor row's onboardingStartedAt and filtering lt/lte.
  // Supabase does not support Firestore-style startAfter(doc), so we use
  // the sort column value from the cursor document as the pagination boundary.
  if (after) {
    const { data: cursorRow } = await supabase
      .from('onboardingProgress')
      .select('onboardingStartedAt')
      .eq('id', after)
      .maybeSingle();
    if (cursorRow?.onboardingStartedAt) {
      query = query.lt('onboardingStartedAt', cursorRow.onboardingStartedAt);
    }
  }

  const { data: rows, error } = await query;
  if (error) {
    logger.error('[DB] getFunnelAnalytics query failed', { error: error.message });
    throw error;
  }

  const docs = rows || [];

  if (docs.length === 0) {
    return {
      total:                  0,
      steps:                  {},
      dropOffByStep:          {},
      importSourceBreakdown:  {},
      scannedAt:              new Date().toISOString(),
    };
  }

  // ── Aggregate counters ────────────────────────────────────────────────────
  let total = 0;
  const stepCounts = {
    consent_saved:              0,
    quick_start_completed:      0,
    education_experience_saved: 0,
    career_report_generated:    0,
    personal_details_saved:     0,
    cv_generated:               0,
    completed:                  0,
    linkedin_imported:          0,
    linkedin_confirmed:         0,
  };
  const dropOffCounts = {};
  const importSources = {};
  const timesToComplete = []; // ms from start to completion

  for (const d of docs) {
    total++;

    // Consent
    if (d.step === 'consent_saved' || d.updatedAt) stepCounts.consent_saved++;

    // Quick start or full education/experience
    if (d.quickStartCompleted || d.experience?.length || d.education?.length) {
      stepCounts.quick_start_completed++;
    }

    // Education + experience enriched
    if (d.experience?.length || d.education?.length) {
      stepCounts.education_experience_saved++;
    }

    // Career report
    if (d.careerReport) stepCounts.career_report_generated++;

    // Personal details
    if (d.personalDetails?.fullName) stepCounts.personal_details_saved++;

    // CV generated or uploaded
    if (d.cvResumeId || d.step === 'cv_generated' || d.step === 'completed_without_cv') {
      stepCounts.cv_generated++;
    }

    // Full completion
    if (d.step === 'completed' || d.step === 'completed_without_cv') {
      stepCounts.completed++;
    }

    // LinkedIn import flow
    if (d.importSource === 'linkedin') stepCounts.linkedin_imported++;
    if (d.importConfirmedAt)           stepCounts.linkedin_confirmed++;

    // Drop-off: last active step before completion
    if (d.lastActiveStep && d.step !== 'completed' && d.step !== 'completed_without_cv') {
      dropOffCounts[d.lastActiveStep] = (dropOffCounts[d.lastActiveStep] || 0) + 1;
    }

    // Import source breakdown
    const src = d.importSource || 'manual';
    importSources[src] = (importSources[src] || 0) + 1;

    // Time to complete
    if (d.onboardingStartedAt && d.step === 'completed') {
      const startedAt   = new Date(d.onboardingStartedAt);
      const completedAt = new Date(d.updatedAt);
      const ms = completedAt - startedAt;
      if (ms > 0 && ms < 7 * 24 * 60 * 60 * 1000) timesToComplete.push(ms); // cap at 7 days
    }
  }

  // ── Conversion rates ──────────────────────────────────────────────────────
  const conversionRates = {};
  const stepOrder = [
    'consent_saved', 'quick_start_completed', 'education_experience_saved',
    'career_report_generated', 'personal_details_saved', 'cv_generated', 'completed',
  ];
  for (const step of stepOrder) {
    conversionRates[step] = total > 0 ? Math.round((stepCounts[step] / total) * 100) : 0;
  }

  // ── Median time to complete ───────────────────────────────────────────────
  let medianCompletionMs = null;
  if (timesToComplete.length > 0) {
    timesToComplete.sort((a, b) => a - b);
    medianCompletionMs = timesToComplete[Math.floor(timesToComplete.length / 2)];
  }

  // ── Biggest drop-off ──────────────────────────────────────────────────────
  const biggestDropOff = Object.entries(dropOffCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([step, count]) => ({ step, count, pctOfTotal: Math.round((count / total) * 100) }));

  return {
    total,
    steps:                stepCounts,
    conversionRates,
    dropOffByStep:        dropOffCounts,
    biggestDropOffs:      biggestDropOff,
    importSourceBreakdown: importSources,
    medianCompletionMs,
    medianCompletionMinutes: medianCompletionMs ? Math.round(medianCompletionMs / 60000) : null,
    scannedDocuments:     total,
    limit,
    hasMore:              docs.length === limit,
    lastDocId:            docs[docs.length - 1]?.id || null,
    scannedAt:            new Date().toISOString(),
  };
}

module.exports = {
  getChiReady,
  getTeaserChi,
  getChiExplainer,
  computeChiCompleteness,
  getProgress,
  getFunnelAnalytics,
};