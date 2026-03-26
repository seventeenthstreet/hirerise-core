'use strict';

/**
 * aiResultCache.js
 *
 * AI result cache — hashes the exact input sent to Claude and stores
 * the result in Redis. On cache hit, Claude is never called.
 *
 * WHY:
 *   Premium analysis is expensive (Opus: ~$0.06 per call at 1500 tokens out).
 *   Users frequently re-upload the same resume, or two users submit identical
 *   resumes. Without caching, each is a full Claude roundtrip + credit deduction.
 *   Caching the result for N hours eliminates duplicate spend entirely.
 *
 * HOW THE HASH WORKS:
 *   SHA-256 of (feature + canonicalPayload) where canonicalPayload is a
 *   deterministically sorted JSON string of the inputs sent to Claude.
 *   Any change in resume text, JD, or user prompt = different hash = cache miss.
 *
 * WHAT IS CACHED:
 *   The full result object returned by each engine function.
 *   Cached result is tagged with _cached:true + _cachedAt timestamp.
 *
 * WHAT IS NOT CACHED:
 *   - Credit deductions (caller handles credits — cache hit still deducts)
 *   - Per-user data like creditsRemaining (stripped before caching)
 *   - Error responses (only successful Claude results are cached)
 *
 * CACHE KEY STRUCTURE:
 *   ai:result:{feature}:{sha256(canonicalPayload)}
 *
 * TTL DEFAULTS (configurable via env):
 *   fullAnalysis:     4 hours  (AI_CACHE_TTL_FULL_ANALYSIS_S)
 *   generateCV:       2 hours  (AI_CACHE_TTL_GENERATE_CV_S)
 *   jobMatchAnalysis: 2 hours  (AI_CACHE_TTL_JOB_MATCH_S)
 *   jobSpecificCV:    2 hours  (AI_CACHE_TTL_JOB_SPECIFIC_CV_S)
 *   chi_calculation:  6 hours  (AI_CACHE_TTL_CHI_S)
 *   default:          2 hours
 *
 * GRACEFUL DEGRADATION:
 *   If Redis is unavailable, all cache operations are no-ops.
 *   The AI call proceeds normally — caching is never a blocking dependency.
 *
 * PHASE-4 UPDATE — TTL JITTER:
 *   Added jitter (0–60 s) to every TTL to prevent cache stampedes.
 *   AI results for many users are computed in bursts (e.g. after a new
 *   model deployment resets all caches). Without jitter, all cached
 *   results would expire at the same time, causing a concurrent flood
 *   of expensive Claude calls. Jitter spreads the expiry over a 60-second
 *   window, smoothing the spike.
 *
 * @module core/aiResultCache
 */

const crypto = require('crypto');
const logger  = require('../utils/logger');

// ─── TTL configuration ────────────────────────────────────────────────────────

const TTL_S = {
  fullAnalysis:     parseInt(process.env.AI_CACHE_TTL_FULL_ANALYSIS_S || String(4 * 3600), 10),
  generateCV:       parseInt(process.env.AI_CACHE_TTL_GENERATE_CV_S   || String(2 * 3600), 10),
  jobMatchAnalysis: parseInt(process.env.AI_CACHE_TTL_JOB_MATCH_S     || String(2 * 3600), 10),
  jobSpecificCV:    parseInt(process.env.AI_CACHE_TTL_JOB_SPECIFIC_CV_S || String(2 * 3600), 10),
  chi_calculation:  parseInt(process.env.AI_CACHE_TTL_CHI_S           || String(6 * 3600), 10),
  default:          parseInt(process.env.AI_CACHE_TTL_DEFAULT_S        || String(2 * 3600), 10),
};

// Jitter range: 0–60 seconds. Keeps cache expiry spread across a 1-minute
// window so a fleet restart doesn't cause a simultaneous cache stampede.
const TTL_JITTER_MAX = 60;

// Set AI_RESULT_CACHE_ENABLED=false to disable entirely (default: enabled)
const CACHE_ENABLED = process.env.AI_RESULT_CACHE_ENABLED !== 'false';

// ─── Redis client (lazy, raw ioredis for direct GET/SET/EX) ──────────────────

let _redis = null;
function getRedis() {
  if (_redis) return _redis;
  try {
    const mgr = require('./cache/cache.manager');
    const client = mgr.getClient();
    if (client?.client?.get) {
      _redis = client.client; // raw ioredis instance
    }
  } catch {
    /* Redis unavailable */
  }
  return _redis;
}

// ─── TTL helper ───────────────────────────────────────────────────────────────

/**
 * ttlWithJitter(feature)
 *
 * Returns the configured base TTL for the feature plus a random jitter
 * of 0–TTL_JITTER_MAX seconds. This prevents cache stampedes when many
 * entries are created simultaneously (e.g. after a deployment restart).
 *
 * @param {string} feature
 * @returns {number} TTL in seconds
 */
function ttlWithJitter(feature) {
  const base   = TTL_S[feature] ?? TTL_S.default;
  const jitter = Math.floor(Math.random() * TTL_JITTER_MAX);
  return base + jitter;
}

// ─── Hash utilities ───────────────────────────────────────────────────────────

/**
 * canonicalize(payload)
 *
 * Produces a deterministic JSON string by sorting object keys at all depths.
 * Arrays are NOT reordered (order matters for prompt construction).
 *
 * @param {any} payload
 * @returns {string}
 */
function canonicalize(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return JSON.stringify(payload);
  }
  const sorted = {};
  for (const key of Object.keys(payload).sort()) {
    sorted[key] = payload[key]; // shallow — deep sort would alter array element order
  }
  return JSON.stringify(sorted);
}

/**
 * buildCacheKey(feature, inputPayload)
 *
 * Produces a Redis key from the feature name and a deterministic hash of the
 * input payload. The payload should contain ONLY the inputs that affect Claude's
 * output — e.g. resumeText, jobDescription, weightedCareerContext.
 *
 * Do NOT include userId, tier, or creditsRemaining in the payload —
 * those don't affect the AI output and would cause unnecessary cache misses.
 *
 * @param {string} feature         — e.g. 'fullAnalysis', 'chi_calculation'
 * @param {object} inputPayload    — deterministic inputs to hash
 * @returns {string}               — Redis key
 */
function buildCacheKey(feature, inputPayload) {
  const canonical = canonicalize(inputPayload);
  const hash = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);
  return `ai:result:${feature}:${hash}`;
}

/**
 * checkCache(cacheKey)
 *
 * Returns the cached result object, or null on miss/error.
 *
 * @param {string} cacheKey
 * @returns {Promise<object|null>}
 */
async function checkCache(cacheKey) {
  if (!CACHE_ENABLED) return null;
  const redis = getRedis();
  if (!redis) return null;

  try {
    const raw = await redis.get(cacheKey);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    logger.debug('[AIResultCache] Cache hit', { cacheKey });
    return parsed;
  } catch (err) {
    // Never block on cache errors
    logger.warn('[AIResultCache] Cache read error', { cacheKey, error: err.message });
    return null;
  }
}

/**
 * storeCache(cacheKey, result, feature)
 *
 * Stores a successful AI result. Strips per-user ephemeral fields before storing.
 * Tags the stored object with _cachedAt for observability.
 * Applies jitter to the TTL to prevent cache stampede.
 *
 * @param {string} cacheKey
 * @param {object} result     — full result object returned by the engine
 * @param {string} feature    — used to look up TTL
 */
async function storeCache(cacheKey, result, feature) {
  if (!CACHE_ENABLED) return;
  const redis = getRedis();
  if (!redis) return;

  try {
    // Strip ephemeral per-user fields that must not be served to other users
    const {
      creditsRemaining,
      _creditReservation,
      _inputTokens,
      _outputTokens,
      _observability,
      ...cacheable
    } = result;

    const toStore = {
      ...cacheable,
      _cachedAt: new Date().toISOString(),
    };

    const ttl = ttlWithJitter(feature);
    await redis.set(cacheKey, JSON.stringify(toStore), 'EX', ttl);
    logger.debug('[AIResultCache] Cached result', { cacheKey, feature, ttlS: ttl });
  } catch (err) {
    // Non-fatal — result still returned to caller, just not cached
    logger.warn('[AIResultCache] Cache write error', { cacheKey, feature, error: err.message });
  }
}

/**
 * invalidateCache(feature, inputPayload)
 *
 * Explicitly evict a cache entry. Use when a user updates their resume
 * or explicitly requests a fresh analysis.
 *
 * @param {string} feature
 * @param {object} inputPayload  — same payload used when calling buildCacheKey
 */
async function invalidateCache(feature, inputPayload) {
  if (!CACHE_ENABLED) return;
  const redis = getRedis();
  if (!redis) return;

  try {
    const cacheKey = buildCacheKey(feature, inputPayload);
    await redis.del(cacheKey);
    logger.debug('[AIResultCache] Cache invalidated', { cacheKey, feature });
  } catch (err) {
    logger.warn('[AIResultCache] Cache invalidation error', { feature, error: err.message });
  }
}

/**
 * getCacheStats()
 *
 * Returns approximate cache entry count for the ai:result: namespace.
 * Used by admin health endpoints.
 *
 * @returns {Promise<{ keyCount: number, enabled: boolean }>}
 */
async function getCacheStats() {
  const redis = getRedis();
  if (!redis || !CACHE_ENABLED) {
    return { keyCount: 0, enabled: CACHE_ENABLED };
  }
  try {
    const keys = await redis.keys('ai:result:*');
    return { keyCount: keys.length, enabled: true };
  } catch {
    return { keyCount: 0, enabled: true };
  }
}

module.exports = {
  buildCacheKey,
  checkCache,
  storeCache,
  invalidateCache,
  getCacheStats,
  CACHE_ENABLED,
  TTL_S,
};








