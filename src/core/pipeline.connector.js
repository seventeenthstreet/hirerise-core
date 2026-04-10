'use strict';

/**
 * pipeline.connector.js — WAVE 3 HARDENED
 */

const logger = require('../utils/logger');

const registry = require('../core/circuitBreaker.registry');
const {
  buildCacheKey,
  checkCache,
  storeCache,
} = require('../core/aiResultCache');

// Lazy imports
const getSupabase = () => require('../config/supabase').supabase;
const getResumeScore = () =>
  require('../services/resumeScore.service');
const getMatching = () =>
  require('../services/careerMatching.service');
const getChi = () =>
  require('../modules/careerHealthIndex/careerHealthIndex.service');

const STEP_TIMEOUT = 15000;
const PIPELINE_CACHE_NAMESPACE = 'pipeline_v3';

// ─────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────

async function withTimeout(fn, name) {
  return Promise.race([
    fn(),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`${name}_TIMEOUT`)),
        STEP_TIMEOUT
      )
    ),
  ]);
}

function normalizeProfileForCache(profile) {
  return {
    userId: profile.userId,
    skills: [...(profile.skills || [])].sort(),
    experienceYears: Number(profile.experienceYears || 0),
    detectedRoles: [...(profile.detectedRoles || [])].sort(),
  };
}

// ─────────────────────────────────────────────
// STEP 1: Load parsedData
// ─────────────────────────────────────────────

async function loadParsedData(userId, resumeId) {
  const supabase = getSupabase();

  let doc = null;

  if (resumeId) {
    const { data } = await supabase
      .from('resumes')
      .select(
        'id, parsed_data, parsedData, top_skills, estimated_experience_years, industry'
      )
      .eq('id', resumeId)
      .eq('user_id', userId)
      .maybeSingle();

    if (data) doc = data;
  }

  if (!doc) {
    const { data } = await supabase
      .from('resumes')
      .select(
        'id, parsed_data, parsedData, top_skills, estimated_experience_years, industry'
      )
      .eq('user_id', userId)
      .eq('soft_deleted', false)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!data) {
      throw Object.assign(new Error('No resume found'), {
        code: 'RESUME_NOT_FOUND',
      });
    }

    doc = data;
  }

  const parsedData = doc.parsedData || doc.parsed_data || {};

  return { resumeDoc: doc, parsedData };
}

// ─────────────────────────────────────────────
// STEP 2: Profile
// ─────────────────────────────────────────────

function buildUserProfile(userId, parsedData = {}) {
  return {
    userId,
    skills: (parsedData.skills || [])
      .map((s) =>
        typeof s === 'string' ? s : s?.name
      )
      .filter(Boolean),
    experienceYears: Number(
      parsedData.yearsExperience || 0
    ),
    detectedRoles: parsedData.detectedRoles || [],
  };
}

// ─────────────────────────────────────────────
// STEP 3: Resume Scoring
// ─────────────────────────────────────────────

async function runScoring(userId) {
  const cacheKey = buildCacheKey('resumeScore_v3', {
    userId,
  });

  const cached = await checkCache(cacheKey);
  if (cached) return cached;

  const svc = getResumeScore();

  const result = await registry.execute(
    registry.FEATURES.RESUME_SCORING,
    async () => svc.calculate(userId),
    { userId }
  );

  await storeCache(cacheKey, result, 'resumeScore_v3');

  return result;
}

// ─────────────────────────────────────────────
// STEP 4: Matching
// ─────────────────────────────────────────────

async function runCareerMatching(userId, userProfile) {
  const normalizedProfile =
    normalizeProfileForCache(userProfile);

  const cacheKey = buildCacheKey(
    'careerMatch_v3',
    normalizedProfile
  );

  const cached = await checkCache(cacheKey);
  if (cached) return cached;

  const { matchCareerRoles } = getMatching();

  const result = await registry.execute(
    registry.FEATURES.CAREER_PATH,
    async () =>
      matchCareerRoles(normalizedProfile, null, {
        limit: 10,
      }),
    { userId }
  );

  await storeCache(
    cacheKey,
    result,
    'careerMatch_v3'
  );

  return result;
}

// ─────────────────────────────────────────────
// STEP 5: CHI
// ─────────────────────────────────────────────

async function runChi(userId, resumeId) {
  const cacheKey = buildCacheKey('chi_v3', {
    userId,
    resumeId,
  });

  const cached = await checkCache(cacheKey);
  if (cached) return cached;

  const { calculateChi } = getChi();

  const result = await registry.execute(
    registry.FEATURES.CHI_CALCULATION,
    async () => calculateChi(userId, resumeId),
    { userId }
  );

  await storeCache(cacheKey, result, 'chi_v3');

  return result;
}

// ─────────────────────────────────────────────
// MAIN PIPELINE
// ─────────────────────────────────────────────

async function runFullPipeline({ userId, resumeId }) {
  const start = Date.now();

  if (!userId) throw new Error('userId required');

  const pipelineCacheKey = buildCacheKey(
    PIPELINE_CACHE_NAMESPACE,
    {
      userId,
      resumeId: resumeId || 'latest',
    }
  );

  const cachedPipeline = await checkCache(
    pipelineCacheKey
  );

  if (cachedPipeline) {
    return cachedPipeline;
  }

  logger.info('[Pipeline] Start', { userId });

  const { parsedData, resumeDoc } =
    await loadParsedData(userId, resumeId);

  const userProfile = buildUserProfile(
    userId,
    parsedData
  );

  const [
    resumeScore,
    careerMatches,
    chiSnapshot,
  ] = await Promise.allSettled([
    withTimeout(() => runScoring(userId), 'SCORING'),
    withTimeout(
      () => runCareerMatching(userId, userProfile),
      'MATCHING'
    ),
    withTimeout(
      () => runChi(userId, resumeDoc?.id),
      'CHI'
    ),
  ]);

  const result = {
    userId,
    resumeId: resumeDoc?.id ?? resumeId ?? null,
    resumeScore:
      resumeScore.status === 'fulfilled'
        ? resumeScore.value
        : null,
    careerMatches:
      careerMatches.status === 'fulfilled'
        ? careerMatches.value
        : [],
    chiSnapshot:
      chiSnapshot.status === 'fulfilled'
        ? chiSnapshot.value
        : null,
    completedAt: new Date().toISOString(),
    latencyMs: Date.now() - start,
    cacheNamespace: PIPELINE_CACHE_NAMESPACE,
  };

  await storeCache(
    pipelineCacheKey,
    result,
    PIPELINE_CACHE_NAMESPACE
  );

  logger.info('[Pipeline] Completed', {
    userId,
    latencyMs: result.latencyMs,
  });

  return result;
}

module.exports = {
  runFullPipeline,
  buildUserProfile,
  loadParsedData,
};