'use strict';

/**
 * Career Digital Twin Engine (Supabase Optimized + AI Vector Integrated)
 */

const crypto       = require('crypto');
const cacheManager = require('../core/cache/cache.manager');
const supabase     = require('../config/supabase');
const logger       = require('../utils/logger');
const { getUserVector } = require('../services/userVector.service'); // ✅ NEW

const careerPathEngine  = require('./career-path.engine');
const opportunityEngine = require('./career-opportunity.engine');

const CACHE_TTL_SECONDS = 900;

const cache = cacheManager?.getClient?.();

// ─────────────────────────────────────────────
// HASH (for cache invalidation)
// ─────────────────────────────────────────────

function profileHash(profile) {
  return crypto.createHash('md5')
    .update(JSON.stringify({
      role: profile.role,
      skills: (profile.skills || []).sort(),
      exp: profile.experience_years,
      industry: profile.industry
    }))
    .digest('hex')
    .slice(0, 10);
}

// ─────────────────────────────────────────────
// MAIN ENGINE
// ─────────────────────────────────────────────

async function simulateCareerPaths(userProfile, marketData = {}) {
  const { role, skills = [], experience_years = 0, industry, userId } = userProfile;

  if (!role) throw new Error('role required');

  const hash     = profileHash(userProfile);
  const cacheKey = `career:twin:${userProfile.role}:${hash}`;

  // 🔥 NEW: Fetch user vector (non-blocking safe usage)
  let userVector = null;
  try {
    if (userId) {
      userVector = await getUserVector(userId, skills);
    }
  } catch (err) {
    logger.warn('[DigitalTwin] user vector fetch failed', {
      userId,
      err: err.message
    });
  }

  // ───────────── Redis Cache ─────────────

  if (cache) {
    try {
      const cached = await cache.get(cacheKey);
      if (cached) {
        logger.debug('[DigitalTwin] Redis hit');
        return JSON.parse(cached);
      }
    } catch (err) {
      logger.warn('[Cache] Redis read failed', { err: err.message });
    }
  }

  // ───────────── Supabase Cache ─────────────

  try {
    const { data } = await supabase
      .from('career_digital_twin_cache')
      .select('result, profile_hash, expires_at')
      .eq('profile_hash', hash)
      .maybeSingle();

    if (data && new Date(data.expires_at) > new Date()) {
      const parsed = JSON.parse(data.result);

      if (cache) {
        await cache.set(cacheKey, JSON.stringify(parsed), 'EX', CACHE_TTL_SECONDS);
      }

      logger.debug('[DigitalTwin] Supabase hit');
      return parsed;
    }
  } catch (err) {
    logger.warn('[DigitalTwin] Supabase read failed', { err: err.message });
  }

  logger.info('[DigitalTwin] Running fresh simulation', { role });

  // ───────────── PARALLEL FETCH ─────────────

  let rawChain = [];
  let opportunityRoles = [];

  try {
    const [chain, opp] = await Promise.all([
      careerPathEngine.getProgressionChain(role, industry).catch(() => []),

      // 🔥 Pass vector for future AI-based opportunity scoring
      opportunityEngine.analyzeCareerOpportunities({
        role,
        skills,
        experience_years,
        industry,
        userId,
        userVector // ✅ NEW (non-breaking)
      }).catch(() => ({ opportunities: [] }))
    ]);

    rawChain = chain || [];

    opportunityRoles = (opp.opportunities || []).slice(0, 10).map(o => ({
      role: o.next_role || o.role,
      years_to_next: o.estimated_years || 2
    }));

  } catch (err) {
    logger.error('[DigitalTwin] Engine dependency failed', { err: err.message });
  }

  const mergedChain =
    rawChain.length > 0 ? rawChain :
    opportunityRoles.length > 0 ? opportunityRoles :
    [{ role: `Senior ${role}`, years_to_next: 2 }];

  // ───────────── SIMULATION ─────────────

  const simulations = mergedChain.slice(0, 5).map((step, i) => ({
    path: [role, step.role],
    next_role: step.role,
    transition_months: step.years_to_next * 12,
    salary_projection: `₹${10 + i * 5}L`,
    growth_score: 60 + i * 5,
    risk_level: 'Medium'
  }));

  const result = {
    career_paths: simulations,
    meta: {
      role,
      experience_years,
      industry,
      simulated_at: new Date().toISOString(),
      path_count: simulations.length,

      // 🔥 NEW: AI metadata (non-breaking)
      vector_used: !!userVector
    }
  };

  // ───────────── CACHE WRITE ─────────────

  if (cache) {
    try {
      await cache.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL_SECONDS);
    } catch (err) {
      logger.warn('[Cache] Redis write failed', { err: err.message });
    }
  }

  // Async Supabase write
  supabase
    .from('career_digital_twin_cache')
    .upsert({
      profile_hash: hash,
      result: JSON.stringify(result),
      expires_at: new Date(Date.now() + CACHE_TTL_SECONDS * 1000).toISOString()
    }, { onConflict: 'profile_hash' })
    .then(() => {})
    .catch(() => {});

  return result;
}

// ─────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────

module.exports = {
  simulateCareerPaths
};