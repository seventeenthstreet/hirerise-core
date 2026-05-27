'use strict';

/**
 * Career Digital Twin Engine (Atomic — Supabase Optimized)
 *
 * Engine purity: accepts pre-computed chain and opportunity data from
 * the owning service. No sibling engine orchestration here.
 * userVector resolved upstream and passed via userProfile.userVector.
 */

const crypto       = require('crypto');
const cacheManager = require('../core/cache/cache.manager');
// Phase 2: lazy getter — resolves Redis post-bootstrap on each call
const getCache = () => cacheManager?.getClient?.() || null;
const supabase     = require('../config/supabase');
const logger       = require('../utils/logger');

const CACHE_TTL_SECONDS = 900;


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
// Accepts pre-resolved careerChain and opportunityRoles from owning service.
// ─────────────────────────────────────────────

async function simulateCareerPaths(userProfile, marketData = {}, engineInputs = {}) {
  const { role, skills = [], experience_years = 0, industry, userVector = null } = userProfile;

  if (!role) throw new Error('role required');

  const hash     = profileHash(userProfile);
  const cacheKey = `career:twin:${userProfile.role}:${hash}`;

  // ───────────── Redis Cache ─────────────

  const cache = getCache();
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

  // ───────────── Pre-computed inputs from owning service ─────────────

  const rawChain = Array.isArray(engineInputs.careerChain) ? engineInputs.careerChain : [];
  const opportunityRoles = Array.isArray(engineInputs.opportunityRoles) ? engineInputs.opportunityRoles : [];

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