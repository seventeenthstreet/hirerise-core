'use strict';

const crypto = require('crypto');
const cacheManager = require('../core/cache/cache.manager');
const { supabase } = require('../config/supabase');
const logger = require('../utils/logger');
const { getUserVector } = require('../services/userVector.service');

const CACHE_TTL = 600;
const MATCH_RPC = 'match_jobs_by_embedding';

const WEIGHTS = Object.freeze({
  semantic: 0.6,
  experience: 0.2,
  industry: 0.1,
  location: 0.1,
});

const cache = cacheManager?.getClient?.();

function hashProfile(profile = {}) {
  return crypto
    .createHash('md5')
    .update(
      JSON.stringify({
        skills: Array.isArray(profile.skills)
          ? [...profile.skills].sort()
          : [],
        exp: Number(profile.yearsExperience ?? 0),
        industry: profile.industry || '',
        location: profile.location || '',
      })
    )
    .digest('hex')
    .slice(0, 8);
}

function fuzzyMatch(a = '', b = '') {
  const na = String(a || '').toLowerCase().trim();
  const nb = String(b || '').toLowerCase().trim();

  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

function getExperienceScore(userExp, requiredExp) {
  const safeUserExp = safeNumber(userExp, 0);
  const safeRequiredExp = safeNumber(requiredExp, 0);

  if (!safeRequiredExp) return 100;
  if (safeUserExp >= safeRequiredExp) return 100;
  return Math.round((safeUserExp / safeRequiredExp) * 100);
}

async function getSemanticJobRecommendations(userProfile = {}, opts = {}) {
  const topN = boundedNumber(opts.topN, 10, 1, 50);
  const minScore = boundedNumber(opts.minScore, 30, 0, 100);

  const {
    userId,
    skills = [],
    yearsExperience = 0,
    industry = '',
    location = '',
  } = userProfile;

  const cacheKey = `semantic:${userId}:${hashProfile(
    userProfile
  )}:${topN}:${minScore}`;

  if (cache) {
    try {
      const cached = await cache.get(cacheKey);
      if (cached) {
        try {
          return normalizeResponse(JSON.parse(cached));
        } catch {
          logger.warn('[Semantic] cache parse failed', { userId });
        }
      }
    } catch (err) {
      logger.warn('[Semantic] cache read failed', {
        userId,
        err: err.message,
      });
    }
  }

  let userVector = null;
  try {
    userVector = await getUserVector(userId, skills);
  } catch (err) {
    logger.error('[Semantic] user vector failed', {
      userId,
      err: err.message,
    });
  }

  if (!Array.isArray(userVector) || !userVector.length) {
    return emptyResponse('no_vector');
  }

  let matches = [];
  try {
    const { data, error } = await supabase.rpc(MATCH_RPC, {
      query_vector: userVector,
      min_score: 0.3,
      top_k: 50,
    });

    if (error) throw error;
    matches = normalizeMatches(data);
  } catch (err) {
    logger.error('[Semantic] RPC failed', {
      userId,
      rpc: MATCH_RPC,
      code: err.code,
      err: err.message,
    });

    return emptyResponse('rpc_failed');
  }

  if (!matches.length) {
    return emptyResponse();
  }

  let jobs = [];
  try {
    const ids = [...new Set(matches.map((m) => m.job_id).filter(Boolean))];

    if (!ids.length) {
      return emptyResponse();
    }

    const { data, error } = await supabase
      .from('jobs')
      .select('*')
      .in('id', ids)
      .eq('status', 'published');

    if (error) throw error;
    jobs = data || [];
  } catch (err) {
    logger.error('[Semantic] job fetch failed', {
      userId,
      err: err.message,
    });

    return emptyResponse('job_fetch_failed');
  }

  const jobMap = Object.create(null);
  jobs.forEach((job) => {
    jobMap[job.id] = job;
  });

  const results = matches
    .map((match) => {
      const job = jobMap[match.job_id];
      if (!job) return null;

      const semanticScore = boundedNumber(
        Math.round(safeNumber(match.similarity, 0) * 100),
        0,
        0,
        100
      );

      const expScore = getExperienceScore(
        yearsExperience,
        job.yearsRequired
      );

      const industryScore = fuzzyMatch(industry, job.industry)
        ? 100
        : 40;

      const locationScore = fuzzyMatch(location, job.location)
        ? 100
        : 60;

      const finalScore = boundedNumber(
        Math.round(
          WEIGHTS.semantic * semanticScore +
            WEIGHTS.experience * expScore +
            WEIGHTS.industry * industryScore +
            WEIGHTS.location * locationScore
        ),
        0,
        0,
        100
      );

      return {
        job_id: job.id,
        title: job.title,
        match_score: finalScore,
        semantic_score: semanticScore,
      };
    })
    .filter(Boolean);

  const recommended = results
    .filter((r) => r.match_score >= minScore)
    .sort((a, b) => b.match_score - a.match_score)
    .slice(0, topN);

  const response = normalizeResponse({
    recommended_jobs: recommended,
    total_found: recommended.length,
    generated_at: new Date().toISOString(),
    engine: 'semantic-pgvector-v2',
    vector_used: true,
  });

  if (cache) {
    try {
      await cache.set(cacheKey, JSON.stringify(response), 'EX', CACHE_TTL);
    } catch (err) {
      logger.warn('[Semantic] cache write failed', {
        userId,
        err: err.message,
      });
    }
  }

  return response;
}

function normalizeMatches(data) {
  if (!Array.isArray(data)) return [];

  return data
    .map((row) => ({
      job_id: row?.job_id ?? row?.id ?? null,
      similarity: safeNumber(row?.similarity ?? row?.score, 0),
    }))
    .filter((row) => row.job_id);
}

function normalizeResponse(payload = {}) {
  return {
    recommended_jobs: Array.isArray(payload.recommended_jobs)
      ? payload.recommended_jobs
      : [],
    total_found: safeNumber(payload.total_found, 0),
    generated_at:
      payload.generated_at || new Date().toISOString(),
    engine: payload.engine || 'semantic-pgvector-v2',
    vector_used: Boolean(payload.vector_used),
    ...(payload.meta ? { meta: payload.meta } : {}),
  };
}

function emptyResponse(error) {
  return normalizeResponse({
    recommended_jobs: [],
    total_found: 0,
    generated_at: new Date().toISOString(),
    engine: 'semantic-pgvector-v2',
    vector_used: false,
    ...(error ? { meta: { error } } : {}),
  });
}

function safeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boundedNumber(value, fallback, min, max) {
  const parsed = safeNumber(value, fallback);
  return Math.min(Math.max(parsed, min), max);
}

module.exports = {
  getSemanticJobRecommendations,
};