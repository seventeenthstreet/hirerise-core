'use strict';

/**
 * src/modules/dashboard/dashboard.service.js
 *
 * Wave 3 Priority #4.1 — CHI canonical repository unification
 *
 * Production-safe dashboard service
 * ✅ CHI reads via canonical repository
 * ✅ Redis cache safe
 * ✅ zero direct chi_snapshots access
 * ✅ partition-ready
 */

const { supabase } = require('../../config/supabase');
const logger = require('../../utils/logger');
const chiSnapshotRepository = require(
  '../careerHealthIndex/chiSnapshot.repository'
);

const {
  CREDIT_COSTS,
  getRemainingUses,
} = require('../analysis/analysis.constants');

let redisClient = null;

const CACHE_KEY_PREFIX = 'dashboard:snap:';
const CACHE_TTL_BASE_SECONDS = 120;
const CACHE_JITTER_MAX_SECONDS = 30;

function getRedis() {
  if (redisClient) return redisClient;

  try {
    const cacheManager = require('../../core/cache/cache.manager');
    const client = cacheManager.getClient();

    redisClient = client?.client?.get
      ? client.client
      : client?.get
      ? client
      : null;
  } catch (error) {
    logger.warn('[DashboardService] Redis unavailable', {
      error: error.message,
    });
    redisClient = null;
  }

  return redisClient;
}

function dashboardCacheKey(userId) {
  return `${CACHE_KEY_PREFIX}${userId}`;
}

async function getCachedSnapshot(userId, tier) {
  const redis = getRedis();
  if (!redis) return null;

  try {
    const raw = await redis.get(dashboardCacheKey(userId));
    if (!raw) return null;

    const parsed = JSON.parse(raw);

    if (parsed?.tier && parsed.tier !== tier) {
      return null;
    }

    return parsed;
  } catch (error) {
    logger.warn('[DashboardService] Cache read failed', {
      userId,
      error: error.message,
    });
    return null;
  }
}

async function setCachedSnapshot(userId, snapshot) {
  const redis = getRedis();
  if (!redis) return;

  try {
    const ttl =
      CACHE_TTL_BASE_SECONDS +
      Math.floor(Math.random() * CACHE_JITTER_MAX_SECONDS);

    await redis.set(
      dashboardCacheKey(userId),
      JSON.stringify(snapshot),
      'EX',
      ttl
    );
  } catch (error) {
    logger.warn('[DashboardService] Cache write failed', {
      userId,
      error: error.message,
    });
  }
}

async function invalidateDashboardCache(userId) {
  const redis = getRedis();
  if (!redis) return;

  try {
    await redis.del(dashboardCacheKey(userId));
  } catch (error) {
    logger.warn('[DashboardService] Cache invalidation failed', {
      userId,
      error: error.message,
    });
  }
}

async function fetchLatestCHI(userId) {
  try {
    const data = await chiSnapshotRepository.getLatest(userId);

    if (!data) return null;

    const currentSalary =
      data.current_estimated_salary_lpa ?? null;
    const nextSalary =
      data.next_level_estimated_salary_lpa ?? null;

    return {
      chiScore: data.chi_score ?? data.chiScore ?? null,
      skillCoverage:
        data.dimensions?.skillVelocity?.score ??
        data.skillCoverage ??
        null,
      growthSummary:
        data.critical_gap ??
        data.growthSummary ??
        null,
      salaryPreview: currentSalary
        ? {
            min: Math.round(currentSalary * 0.9),
            max: Math.round(
              nextSalary ?? currentSalary * 1.3
            ),
            currency: 'INR',
          }
        : null,
    };
  } catch (error) {
    logger.warn('[DashboardService] CHI fetch failed', {
      userId,
      error: error.message,
    });
    return null;
  }
}

async function fetchLatestJobMatch(userId) {
  const fallback = {
    hasAnalyzedBefore: false,
    lastMatchScore: null,
    lastJobTitle: null,
    lastAnalyzedAt: null,
  };

  try {
    const { data, error } = await supabase
      .from('job_match_analyses')
      .select(`
        match_score,
        job_title,
        analyzed_at
      `)
      .eq('user_id', userId)
      .order('analyzed_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) return fallback;

    return {
      hasAnalyzedBefore: true,
      lastMatchScore: data.match_score ?? null,
      lastJobTitle: data.job_title ?? null,
      lastAnalyzedAt: data.analyzed_at ?? null,
    };
  } catch (error) {
    logger.warn('[DashboardService] Job match fetch failed', {
      userId,
      error: error.message,
    });
    return fallback;
  }
}

async function fetchCredits(userId, tier) {
  if (tier === 'free') return 0;

  try {
    const { data, error } = await supabase
      .from('users')
      .select('ai_credits_remaining')
      .eq('id', userId)
      .maybeSingle();

    if (error) return 0;

    return data?.ai_credits_remaining ?? 0;
  } catch (error) {
    logger.warn('[DashboardService] Credit fetch failed', {
      userId,
      error: error.message,
    });
    return 0;
  }
}

function computeCanRunFlags(tier, credits) {
  if (tier === 'free') {
    return {
      canRunJobMatch: true,
      canGenerateJobSpecificCV: false,
    };
  }

  return {
    canRunJobMatch:
      credits >= CREDIT_COSTS.jobMatchAnalysis,
    canGenerateJobSpecificCV:
      credits >= CREDIT_COSTS.jobSpecificCV,
  };
}

function buildFeatures(tier, chiData) {
  const isPremium = tier !== 'free';

  return {
    basicAnalysis: {
      locked: false,
      jobMatchScore: chiData?.chiScore ?? null,
    },
    careerHealth: {
      locked: false,
      chiScore: chiData?.chiScore ?? null,
      skillCoverage: chiData?.skillCoverage ?? null,
      growthSummary: chiData?.growthSummary ?? null,
    },
    salaryGap: {
      locked: !isPremium,
      salaryPreview: isPremium
        ? chiData?.salaryPreview ?? null
        : null,
    },
    advancedInsights: {
      locked: !isPremium,
      data: null,
    },
  };
}

async function getDashboardData(userId, tier) {
  const cached = await getCachedSnapshot(userId, tier);
  if (cached) return cached;

  const [credits, chiData, jobMatchData] =
    await Promise.all([
      fetchCredits(userId, tier),
      fetchLatestCHI(userId),
      fetchLatestJobMatch(userId),
    ]);

  const remainingUses =
    tier !== 'free'
      ? getRemainingUses(credits)
      : Object.fromEntries(
          Object.keys(CREDIT_COSTS).map((op) => [op, 0])
        );

  const snapshot = {
    tier,
    features: buildFeatures(tier, chiData),
    user: {
      tier,
      aiCreditsRemaining: credits,
    },
    careerIntelligence: chiData ?? {
      chiScore: null,
      skillCoverage: null,
      growthSummary: null,
      salaryPreview: null,
    },
    applySmarter: jobMatchData,
    credits: {
      remaining: credits,
      remainingUses,
      ...computeCanRunFlags(tier, credits),
    },
  };

  await setCachedSnapshot(userId, snapshot);

  return snapshot;
}

module.exports = {
  getDashboardData,
  invalidateDashboardCache,
};