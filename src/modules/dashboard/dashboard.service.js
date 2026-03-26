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
 *
 * PHASE-4 UPDATE — Redis Snapshot Cache:
 *
 *   PROBLEM:
 *     Every GET /api/v1/dashboard triggered two Firestore queries
 *     (latest CHI + latest job-match) regardless of how recently the data
 *     changed. At 1000 DAU × 3 dashboard loads per session = 6000 Firestore
 *     reads per day just from dashboard calls.
 *
 *   SOLUTION:
 *     Cache getDashboardData() results in Redis under:
 *       dashboard:snap:{userId}
 *     TTL: 120 seconds + jitter(0–30 s) to prevent stampede.
 *
 *   INVALIDATION:
 *     The exported invalidateDashboardCache(userId) function deletes the key.
 *     Call it from:
 *       - resume upload / delete handlers
 *       - profile update handlers
 *       - CHI recalculation completion handlers
 *
 *   GRACEFUL DEGRADATION:
 *     If Redis is unavailable, getDashboardData falls through to Firestore
 *     as before. Caching is never a blocking dependency.
 */

const { db }                             = require('../../config/supabase');
const { CREDIT_COSTS, getRemainingUses } = require('../analysis/analysis.constants');

// ─── Redis client (lazy, same pattern as tokenCache / aiResultCache) ──────────

let _redis = null;
function getRedis() {
  if (_redis) return _redis;
  try {
    const mgr    = require('../../core/cache/cache.manager');
    const client = mgr.getClient();
    // Prefer the raw ioredis client for direct set/get/del operations
    if (client?.client?.get) {
      _redis = client.client;
    } else if (client?.get) {
      _redis = client;
    }
  } catch {
    /* Redis unavailable */
  }
  return _redis;
}

// ─── Cache configuration ─────────────────────────────────────────────────────

const CACHE_KEY_PREFIX = 'dashboard:snap:';
const CACHE_TTL_BASE   = 120; // seconds
const CACHE_JITTER_MAX = 30;  // jitter 0–30 s to prevent stampede
const logger = require('../../utils/logger');

// ─── Cache helpers ────────────────────────────────────────────────────────────

function dashboardCacheKey(userId) {
  return `${CACHE_KEY_PREFIX}${userId}`;
}

async function getCachedSnapshot(userId) {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(dashboardCacheKey(userId));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    logger.warn('[DashboardService] Cache read error', { userId, error: err.message });
    return null;
  }
}

async function setCachedSnapshot(userId, snapshot) {
  const redis = getRedis();
  if (!redis) return;
  try {
    const jitter = Math.floor(Math.random() * CACHE_JITTER_MAX);
    const ttl    = CACHE_TTL_BASE + jitter;
    await redis.set(dashboardCacheKey(userId), JSON.stringify(snapshot), 'EX', ttl);
    logger.debug('[DashboardService] Snapshot cached', { userId, ttlS: ttl });
  } catch (err) {
    // Non-fatal — dashboard still returned from Firestore
    logger.warn('[DashboardService] Cache write error', { userId, error: err.message });
  }
}

/**
 * invalidateDashboardCache(userId)
 *
 * Exported for use by resume, profile, and CHI handlers.
 * Deletes the cached snapshot so the next dashboard request re-fetches
 * from Firestore with fresh data.
 *
 * Call this after:
 *   - POST   /api/v1/resumes          (resume uploaded)
 *   - DELETE /api/v1/resumes/:id      (resume deleted)
 *   - PUT    /api/v1/users/me         (profile updated)
 *   - POST   /api/v1/career-health/calculate (CHI recalculated)
 *
 * @param {string} userId
 */
async function invalidateDashboardCache(userId) {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(dashboardCacheKey(userId));
    logger.debug('[DashboardService] Cache invalidated', { userId });
  } catch (err) {
    logger.warn('[DashboardService] Cache invalidation error', { userId, error: err.message });
  }
}

// ─── Firestore fetchers (unchanged) ──────────────────────────────────────────

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

// ─── Public service function ──────────────────────────────────────────────────

/**
 * getDashboardData(userId, tier)
 *
 * Returns the dashboard payload. Checks Redis cache first; falls back to
 * Firestore if cache is cold or Redis is unavailable.
 *
 * @param {string} userId
 * @param {string} tier — normalized tier from custom claim (never from Firestore)
 */
async function getDashboardData(userId, tier) {
  // ── 1. Cache check ───────────────────────────────────────────────────────
  const cached = await getCachedSnapshot(userId);
  if (cached) {
    logger.debug('[DashboardService] Cache hit', { userId });
    return cached;
  }

  // ── 2. Firestore fetch ───────────────────────────────────────────────────
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

  const snapshot = {
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

  // ── 3. Cache the result ──────────────────────────────────────────────────
  await setCachedSnapshot(userId, snapshot);

  return snapshot;
}

module.exports = { getDashboardData, invalidateDashboardCache };








