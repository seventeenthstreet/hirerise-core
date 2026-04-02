'use strict';

/**
 * @file src/modules/career-copilot/retrieval/ragRetriever.js
 * @description
 * Production-grade Supabase RAG context retriever.
 *
 * Optimized for:
 * - Single Supabase RPC round trip via get_rag_context_v1()
 * - JSONB-safe payload normalization
 * - partial-failure isolation (skill_gaps + job_matches remain local)
 * - cache-first low-latency repeated prompts
 * - deterministic confidence scoring
 *
 * Architecture note:
 *   skill_gaps and job_matches are NOT fetched by the RPC — they depend on
 *   Node-side engines that have no SQL equivalent.
 *   They are fetched in parallel with the RPC and merged into the final
 *   context object to preserve full downstream contract compatibility.
 */

const { supabase } = require('../../../config/supabase');
const cacheManager = require('../../../core/cache/cache.manager');
const logger = require('../../../utils/logger');

const CONTEXT_CACHE_TTL = 300;
const CACHE_VERSION = 'v1';
const MIN_COMPLETENESS_THRESHOLD = 0.25;

const SOURCE_WEIGHTS = Object.freeze({
  user_profile: 0.20,
  chi_score: 0.15,
  skill_gaps: 0.15,
  job_matches: 0.15,
  opportunity_radar: 0.12,
  risk_analysis: 0.10,
  salary_benchmarks: 0.08,
  personalization_profile: 0.05,
});

const ALL_SOURCES = Object.freeze(Object.keys(SOURCE_WEIGHTS));

const cache = cacheManager.getClient();
const moduleCache = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeRpcObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

function loadModule(path) {
  if (moduleCache.has(path)) return moduleCache.get(path);

  try {
    const loaded = require(path);
    moduleCache.set(path, loaded);
    return loaded;
  } catch {
    moduleCache.set(path, null);
    return null;
  }
}

function unwrapSettled(result) {
  return result?.status === 'fulfilled' ? result.value : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Node-only fetchers
// ─────────────────────────────────────────────────────────────────────────────
async function fetchSkillGaps(userId) {
  const service = loadModule('../../../modules/jobSeeker/skillGraphEngine.service');
  if (!service) return null;

  const fn = service.detectSkillGap || service.getUserSkillGraph;
  if (typeof fn !== 'function') return null;

  const result = await fn.call(service, userId);
  if (!result) return null;

  return {
    existing_skills: safeArray(result.existing_skills),
    missing_high_demand: safeArray(result.missing_high_demand).slice(0, 8),
    adjacent_skills: safeArray(result.adjacent_skills).slice(0, 6),
    role_gap: normalizeRpcObject(result.role_gap),
    target_role: result.target_role || null,
  };
}

async function fetchJobMatches(userId) {
  const service = loadModule('../../../modules/jobSeeker/jobMatchingEngine.service');
  if (!service?.getJobMatches) return null;

  const result = await service.getJobMatches(userId, { limit: 5 });
  const jobs = safeArray(result?.recommended_jobs);
  if (!jobs.length) return null;

  return {
    top_matches: jobs.slice(0, 5).map((job) => ({
      title: job.title || null,
      match_score: job.match_score ?? null,
      missing_skills: safeArray(job.missing_skills).slice(0, 4),
      salary: normalizeRpcObject(job.salary),
      company: job.company || null,
    })),
    total_evaluated: result.total_roles_evaluated || 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Score recalculation after merge
// ─────────────────────────────────────────────────────────────────────────────
function recalculateScores(context) {
  let confidence = 0;

  for (const [source, weight] of Object.entries(SOURCE_WEIGHTS)) {
    if (context[source] != null) confidence += weight;
  }

  const skills = context.user_profile?.skills;
  const hasSkills = Array.isArray(skills)
    ? skills.length > 0
    : typeof skills === 'object' && skills !== null;

  if (hasSkills && context.user_profile?.target_role) {
    confidence = Math.min(1, confidence + 0.05);
  }

  const populated = ALL_SOURCES.filter((source) => context[source] != null).length;

  return {
    data_sources_used: ALL_SOURCES.filter((source) => context[source] != null),
    data_completeness: Math.round((populated / ALL_SOURCES.length) * 1000) / 1000,
    confidence_score: Math.round(confidence * 1000) / 1000,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// RPC fetch
// ─────────────────────────────────────────────────────────────────────────────
async function fetchRpcContext(userId) {
  const { data, error } = await supabase.rpc('get_rag_context_v1', {
    p_user_id: userId,
  });

  if (error) {
    logger.error('[RAGRetriever] RPC get_rag_context_v1 failed', {
      userId,
      error: error.message,
      code: error.code,
    });
    return null;
  }

  return normalizeRpcObject(data);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────
async function retrieveContext(userId, opts = {}) {
  const forceRefresh = !!opts.forceRefresh;
  const cacheKey = `rag:context:${CACHE_VERSION}:${userId}`;

  if (!forceRefresh) {
    try {
      const cached = await cache.get(cacheKey);
      if (cached) {
        logger.debug('[RAGRetriever] Context cache hit', { userId });
        return { ...JSON.parse(cached), _cached: true };
      }
    } catch (err) {
      logger.warn('[RAGRetriever] Cache read failed', {
        userId,
        error: err.message,
      });
    }
  }

  const startedAt = Date.now();
  logger.info('[RAGRetriever] Fetching context', { userId });

  const [rpcResult, settledNodeSources] = await Promise.all([
    fetchRpcContext(userId),
    Promise.allSettled([
      fetchSkillGaps(userId),
      fetchJobMatches(userId),
    ]),
  ]);

  const [skillGaps, jobMatches] = settledNodeSources.map(unwrapSettled);

  const nodeFailures = settledNodeSources.filter(
    (result) => result.status === 'rejected'
  );

  if (nodeFailures.length) {
    logger.warn('[RAGRetriever] Node-side partial failures', {
      userId,
      failed: nodeFailures.length,
      errors: nodeFailures.map((r) => r.reason?.message).filter(Boolean),
    });
  }

  const context = {
    user_profile: normalizeRpcObject(rpcResult?.user_profile),
    chi_score: normalizeRpcObject(rpcResult?.chi_score),
    skill_gaps: skillGaps,
    job_matches: jobMatches,
    opportunity_radar: normalizeRpcObject(rpcResult?.opportunity_radar),
    risk_analysis: normalizeRpcObject(rpcResult?.risk_analysis),
    salary_benchmarks: normalizeRpcObject(rpcResult?.salary_benchmarks),
    personalization_profile: normalizeRpcObject(
      rpcResult?.personalization_profile
    ),
  };

  const {
    data_sources_used,
    data_completeness,
    confidence_score,
  } = recalculateScores(context);

  const ragContext = {
    ...context,
    data_sources_used,
    data_completeness,
    confidence_score,
    is_sufficient:
      data_completeness >= MIN_COMPLETENESS_THRESHOLD,
    retrieval_ms: Date.now() - startedAt,
    retrieved_at: new Date().toISOString(),
  };

  try {
    await cache.set(
      cacheKey,
      JSON.stringify(ragContext),
      'EX',
      CONTEXT_CACHE_TTL
    );
  } catch (err) {
    logger.warn('[RAGRetriever] Cache write failed', {
      userId,
      error: err.message,
    });
  }

  logger.info('[RAGRetriever] Context assembled', {
    userId,
    sources: data_sources_used.length,
    completeness: data_completeness,
    confidence: confidence_score,
    retrieval_ms: ragContext.retrieval_ms,
    rpc_ok: rpcResult !== null,
  });

  return ragContext;
}

module.exports = {
  retrieveContext,
  MIN_COMPLETENESS_THRESHOLD,
  SOURCE_WEIGHTS,
  ALL_SOURCES,
};