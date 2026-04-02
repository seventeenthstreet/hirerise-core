'use strict';

const crypto = require('crypto');
const cacheManager = require('../core/cache/cache.manager');
const { supabase } = require('../config/supabase');
const logger = require('../utils/logger');
const { getUserVector } = require('../services/userVector.service');

const CACHE_TTL = 600;

const WEIGHTS = Object.freeze({
  semantic: 0.6,
  experience: 0.2,
  industry: 0.1,
  location: 0.1
});

const cache = cacheManager?.getClient?.();

// ─────────────────────────────────────────────
// PROFILE HASH
// ─────────────────────────────────────────────

function hashProfile(profile) {
  return crypto.createHash('md5')
    .update(JSON.stringify({
      skills: (profile.skills || []).sort(),
      exp: profile.yearsExperience,
      industry: profile.industry,
      location: profile.location
    }))
    .digest('hex')
    .slice(0, 8);
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function fuzzyMatch(a = '', b = '') {
  const na = a.toLowerCase().trim();
  const nb = b.toLowerCase().trim();
  return na === nb || na.includes(nb) || nb.includes(na);
}

function getExperienceScore(userExp, requiredExp) {
  if (!requiredExp) return 100;
  if (userExp >= requiredExp) return 100;
  return Math.round((userExp / requiredExp) * 100);
}

// ─────────────────────────────────────────────
// MAIN ENGINE
// ─────────────────────────────────────────────

async function getSemanticJobRecommendations(userProfile, opts = {}) {
  const { topN = 10, minScore = 30 } = opts;

  const {
    userId,
    skills = [],
    yearsExperience = 0,
    industry = '',
    location = ''
  } = userProfile;

  const cacheKey = `semantic:${userId}:${hashProfile(userProfile)}:${topN}:${minScore}`;

  // 🔹 Cache
  if (cache) {
    try {
      const cached = await cache.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch (err) {
      logger.warn('[Semantic] cache read failed', { err: err.message });
    }
  }

  // 🔹 Get user vector (safe)
  let userVector = null;
  try {
    userVector = await getUserVector(userId, skills);
  } catch (err) {
    logger.error('[Semantic] user vector failed', {
      userId,
      err: err.message
    });
  }

  if (!userVector) {
    return {
      recommended_jobs: [],
      meta: { error: 'no_vector' }
    };
  }

  // 🔹 RPC call
  let matches = [];
  try {
    const { data, error } = await supabase.rpc('match_jobs_by_embedding', {
      query_vector: userVector,
      min_score: 0.3,
      top_k: 50
    });

    if (error) throw error;
    matches = data || [];
  } catch (err) {
    logger.error('[Semantic] RPC failed', { err: err.message });
    return { recommended_jobs: [] };
  }

  if (!matches.length) {
    return { recommended_jobs: [] };
  }

  // 🔹 Fetch jobs
  let jobs = [];
  try {
    const { data, error } = await supabase
      .from('jobs')
      .select('*')
      .in('id', matches.map(m => m.job_id));

    if (error) throw error;
    jobs = data || [];
  } catch (err) {
    logger.error('[Semantic] job fetch failed', { err: err.message });
    return { recommended_jobs: [] };
  }

  const jobMap = {};
  jobs.forEach(j => jobMap[j.id] = j);

  // 🔹 Hybrid scoring (UNCHANGED LOGIC)
  const results = matches.map(m => {
    const job = jobMap[m.job_id];
    if (!job) return null;

    const semanticScore = Math.round(m.similarity * 100);
    const expScore = getExperienceScore(yearsExperience, job.yearsRequired);
    const industryScore = fuzzyMatch(industry, job.industry) ? 100 : 40;
    const locationScore = fuzzyMatch(location, job.location) ? 100 : 60;

    const finalScore = Math.round(
      WEIGHTS.semantic * semanticScore +
      WEIGHTS.experience * expScore +
      WEIGHTS.industry * industryScore +
      WEIGHTS.location * locationScore
    );

    return {
      job_id: job.id,
      title: job.title,
      match_score: finalScore,
      semantic_score: semanticScore
    };
  }).filter(Boolean);

  // 🔹 Rank + filter
  const recommended = results
    .filter(r => r.match_score >= minScore)
    .sort((a, b) => b.match_score - a.match_score)
    .slice(0, topN);

  const response = {
    recommended_jobs: recommended,
    total_found: recommended.length,
    generated_at: new Date().toISOString(),
    engine: 'semantic-pgvector-v2',

    // 🔥 NEW META
    vector_used: true
  };

  // 🔹 Cache write
  if (cache) {
    try {
      await cache.set(cacheKey, JSON.stringify(response), 'EX', CACHE_TTL);
    } catch (err) {
      logger.warn('[Semantic] cache write failed', { err: err.message });
    }
  }

  return response;
}

module.exports = {
  getSemanticJobRecommendations
};