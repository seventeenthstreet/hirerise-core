'use strict';

/**
 * dashboard.service.js — FINAL ARCHITECTURE
 *
 * Single tier-aware dashboard. No /dashboard/free or /dashboard/pro.
 *
 * Response adds:
 *   tier (top-level)
 *   features.salaryGap.locked
 *   features.advancedInsights.locked
 *
 * Tier NEVER read from Firestore — received as param from route.
 */

const { db }                             = require('../../config/firebase');
const { CREDIT_COSTS, getRemainingUses } = require('../analysis/analysis.constants');

async function fetchLatestCHI(userId) {
  try {
    const snap = await db
      .collection('careerHealthIndex')
      .where('userId',      '==', userId)
      .where('softDeleted', '==', false)
      .orderBy('generatedAt', 'desc')
      .limit(1)
      .get();

    if (snap.empty) return null;

    const d = snap.docs[0].data();
    return {
      chiScore:      d.chiScore                        ?? null,
      skillCoverage: d.dimensions?.skillVelocity?.score ?? null,
      growthSummary: d.criticalGap                     ?? null,
      salaryPreview: d.currentEstimatedSalaryLPA
        ? {
            min:      Math.round(d.currentEstimatedSalaryLPA * 0.9),
            max:      Math.round(d.nextLevelEstimatedSalaryLPA ?? d.currentEstimatedSalaryLPA * 1.3),
            currency: 'INR',
          }
        : null,
    };
  } catch { return null; }
}

async function fetchLatestJobMatch(userId) {
  try {
    const snap = await db
      .collection('jobMatchAnalyses')
      .where('userId', '==', userId)
      .orderBy('analyzedAt', 'desc')
      .limit(1)
      .get();

    if (snap.empty) {
      return { hasAnalyzedBefore: false, lastMatchScore: null, lastJobTitle: null, lastAnalyzedAt: null };
    }

    const d = snap.docs[0].data();
    return {
      hasAnalyzedBefore: true,
      lastMatchScore:    d.matchScore ?? null,
      lastJobTitle:      d.jobTitle   ?? null,
      lastAnalyzedAt:    d.analyzedAt?.toDate?.()?.toISOString?.() ?? null,
    };
  } catch {
    return { hasAnalyzedBefore: false, lastMatchScore: null, lastJobTitle: null, lastAnalyzedAt: null };
  }
}

function computeCanRunFlags(tier, credits) {
  if (tier === 'free') {
    return { canRunJobMatch: true, canGenerateJobSpecificCV: false };
  }
  return {
    canRunJobMatch:           credits >= CREDIT_COSTS.jobMatchAnalysis,
    canGenerateJobSpecificCV: credits >= CREDIT_COSTS.jobSpecificCV,
  };
}

function buildFeatures(tier, chiData) {
  const isPremium = tier !== 'free';

  return {
    basicAnalysis: {
      locked:        false,
      jobMatchScore: chiData?.chiScore ?? null,
    },
    careerHealth: {
      locked:        false,
      chiScore:      chiData?.chiScore      ?? null,
      skillCoverage: chiData?.skillCoverage ?? null,
      growthSummary: chiData?.growthSummary ?? null,
    },
    salaryGap: {
      locked:        !isPremium,
      salaryPreview: isPremium ? (chiData?.salaryPreview ?? null) : null,
    },
    advancedInsights: {
      locked: !isPremium,
      data:   null,
    },
  };
}

/**
 * getDashboardData(userId, tier)
 *
 * @param {string} userId
 * @param {string} tier — normalized tier from custom claim (never from Firestore)
 */
async function getDashboardData(userId, tier) {
  let credits = 0;
  if (tier !== 'free') {
    try {
      const userSnap = await db.collection('users').doc(userId).get();
      credits = userSnap.exists ? (userSnap.data().aiCreditsRemaining ?? 0) : 0;
    } catch { credits = 0; }
  }

  const [chiData, jobMatchData] = await Promise.all([
    fetchLatestCHI(userId),
    fetchLatestJobMatch(userId),
  ]);

  const remainingUses = tier !== 'free'
    ? getRemainingUses(credits)
    : Object.fromEntries(Object.keys(CREDIT_COSTS).map(op => [op, 0]));

  const canRunFlags = computeCanRunFlags(tier, credits);
  const features    = buildFeatures(tier, chiData);

  return {
    tier,
    features,
    user: {
      tier,
      aiCreditsRemaining: credits,
    },
    careerIntelligence: chiData ?? {
      chiScore: null, skillCoverage: null, growthSummary: null, salaryPreview: null,
    },
    applySmarter: jobMatchData,
    credits: {
      remaining:    credits,
      remainingUses,
      ...canRunFlags,
    },
  };
}

module.exports = { getDashboardData };
