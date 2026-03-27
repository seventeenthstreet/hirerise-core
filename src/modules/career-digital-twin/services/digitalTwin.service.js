'use strict';

/**
 * modules/career-digital-twin/services/digitalTwin.service.js
 *
 * Orchestration layer for the Career Digital Twin Engine.
 *
 * Responsibilities:
 *   1. Validate and normalise the incoming user profile.
 *   2. Check Redis / in-memory cache for a warm simulation result.
 *   3. If cache miss → call CareerDigitalTwinEngine.simulateCareerPaths().
 *   4. Optionally enrich with AI-generated narrative (includeNarrative flag).
 *   5. Persist result to Supabase (career_simulations table).
 *   6. Write result to cache with 30-minute TTL.
 *   7. Return shaped response to the controller.
 *
 * Cache strategy:
 *   Key:  digital_twin:{userId}:{roleSlug}
 *   TTL:  1800 seconds (30 minutes)
 *   Store: Redis when CACHE_PROVIDER=redis, else in-memory
 *
 * Supabase persistence:
 *   Table: career_simulations
 *   One row per (userId, simulation run). Old runs are not deleted —
 *   history is preserved for the career timeline feature.
 *
 * @module modules/career-digital-twin/services/digitalTwin.service
 */

'use strict';

const logger = require('../../../utils/logger');
const anthropic = require('../../../config/anthropic.client');
const supabase = require('../../../core/supabaseClient');
const cacheManager = require('../../../core/cache/cache.manager');
const engine = require('../../../engines/career-digital-twin.engine');
const { buildSimulationDoc } = require('../models/simulation.model');
const { buildNarrativeMessages } = require('../prompts/twinPrompt.builder');

// ─── Config ───────────────────────────────────────────────────────────────────

const COLLECTION = 'career_simulations';
const CACHE_TTL_SEC = parseInt(process.env.DIGITAL_TWIN_CACHE_TTL_SEC || '1800', 10); // 30 min
const AI_MAX_TOKENS = 1500;
const NARRATIVE_MODEL = 'claude-sonnet-4-20250514';

// ─── Cache helpers ────────────────────────────────────────────────────────────

/**
 * Build a deterministic, safe cache key for a user + role combination.
 * Spaces and special chars are replaced so Redis key constraints are met.
 *
 * @param {string} userId
 * @param {string} role
 * @returns {string}
 */
function _cacheKey(userId, role) {
  const slug = (role || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .slice(0, 60);
  return `digital_twin:${userId}:${slug}`;
}

/**
 * Attempt to read a cached simulation result.
 * Returns null on any cache error so callers always get a result.
 *
 * @param {string} key
 * @returns {Promise<Object|null>}
 */
async function _cacheGet(key) {
  try {
    const cache = cacheManager.getClient();
    const raw = await cache.get(key);
    if (raw) {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      logger.debug('[DigitalTwinService] Cache HIT', { key });
      return parsed;
    }
  } catch (err) {
    logger.warn('[DigitalTwinService] Cache GET error (non-fatal)', {
      key,
      err: err.message
    });
  }
  return null;
}

/**
 * Write a simulation result to cache.
 * Silently swallows errors — a cache write failure should never block a response.
 *
 * @param {string} key
 * @param {Object} value
 * @returns {Promise<void>}
 */
async function _cacheSet(key, value) {
  try {
    const cache = cacheManager.getClient();
    await cache.set(key, JSON.stringify(value), CACHE_TTL_SEC);
    logger.debug('[DigitalTwinService] Cache SET', { key, ttl: CACHE_TTL_SEC });
  } catch (err) {
    logger.warn('[DigitalTwinService] Cache SET error (non-fatal)', {
      key,
      err: err.message
    });
  }
}

// ─── AI narrative enrichment ──────────────────────────────────────────────────

/**
 * Optionally enrich simulation paths with AI-generated narrative summaries.
 * Returns the original paths unchanged on any AI failure — never throws.
 *
 * @param {Object}   userProfile
 * @param {Object[]} careerPaths
 * @returns {Promise<Object[]>}  careerPaths with optional .narrative field added
 */
async function _enrichWithNarratives(userProfile, careerPaths) {
  if (!anthropic) {
    logger.warn('[DigitalTwinService] AI client unavailable, skipping narratives');
    return careerPaths;
  }
  try {
    const { system, messages } = buildNarrativeMessages(userProfile, careerPaths);
    const response = await anthropic.messages.create({
      model: NARRATIVE_MODEL,
      max_tokens: AI_MAX_TOKENS,
      temperature: 0.4,
      system,
      messages
    });
    const raw = response.content?.[0]?.text || '';
    // Strip possible markdown fences before parsing
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    const narrativeMap = new Map(
      (parsed.narratives || []).map(n => [n.strategy_id, n])
    );
    return careerPaths.map(p => {
      const n = narrativeMap.get(p.strategy_id);
      if (!n) return p;
      return {
        ...p,
        narrative: n.summary || null,
        key_milestone: n.key_milestone || null
      };
    });
  } catch (err) {
    logger.warn('[DigitalTwinService] Narrative enrichment failed (non-fatal)', {
      err: err.message
    });
    return careerPaths; // graceful degradation
  }
}

// ─── Supabase persistence ─────────────────────────────────────────────────────

/**
 * Persist a simulation result to Supabase.
 * Non-blocking — awaited but errors are swallowed so they never block the API.
 *
 * @param {string} userId
 * @param {Object} simulationResult
 * @returns {Promise<string|null>}  Inserted row ID or null on failure
 */
async function _persist(userId, simulationResult) {
  try {
    const doc = buildSimulationDoc(userId, simulationResult);
    const { data, error } = await supabase
      .from(COLLECTION)
      .insert(doc)
      .select('id')
      .single();
    if (error) throw error;
    logger.info('[DigitalTwinService] Simulation persisted', {
      userId,
      docId: data?.id
    });
    return data?.id || null;
  } catch (err) {
    logger.warn('[DigitalTwinService] Supabase persist failed (non-fatal)', {
      userId,
      err: err.message
    });
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * runSimulation({ userId, userProfile, marketData, includeNarrative, forceRefresh })
 *
 * Main entry point. Checks cache, runs engine, optionally adds AI narratives,
 * persists to Supabase, writes to cache, and returns the simulation result.
 *
 * @param {Object}  params
 * @param {string}  params.userId              — user ID
 * @param {Object}  params.userProfile         — { role, skills[], experience_years, industry }
 * @param {Object}  [params.marketData]        — optional market enrichment data
 * @param {boolean} [params.includeNarrative]  — if true, add AI-written path summaries
 * @param {boolean} [params.forceRefresh]      — if true, skip cache read
 *
 * @returns {Promise<Object>}
 *   { career_paths, meta, cached, simulation_id? }
 */
async function runSimulation({
  userId,
  userProfile,
  marketData = {},
  includeNarrative = false,
  forceRefresh = false
}) {
  const key = _cacheKey(userId, userProfile.role);

  // ── Cache read ────────────────────────────────────────────────────────────
  if (!forceRefresh) {
    const cached = await _cacheGet(key);
    if (cached) {
      return { ...cached, cached: true };
    }
  }

  // ── Engine run ────────────────────────────────────────────────────────────
  logger.info('[DigitalTwinService] Running simulation (cache miss)', {
    userId,
    role: userProfile.role
  });
  const simulationResult = await engine.simulateCareerPaths(userProfile, marketData);

  // ── Optional AI narrative enrichment ──────────────────────────────────────
  if (includeNarrative) {
    simulationResult.career_paths = await _enrichWithNarratives(
      userProfile,
      simulationResult.career_paths
    );
  }

  // ── Persist to Supabase (non-blocking intent, awaited for row ID) ──────────
  const simulationId = await _persist(userId, simulationResult);

  // ── Cache write ───────────────────────────────────────────────────────────
  const response = {
    ...simulationResult,
    simulation_id: simulationId,
    cached: false
  };
  await _cacheSet(key, response);
  return response;
}

/**
 * getStoredSimulations(userId, limit?)
 *
 * Fetch past simulation records for a user from Supabase.
 * Used by GET /api/career/simulations.
 *
 * @param {string} userId
 * @param {number} [limit=10]
 * @returns {Promise<Object[]>}
 */
async function getStoredSimulations(userId, limit = 10) {
  try {
    const { data, error } = await supabase
      .from(COLLECTION)
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return (data || []).map(row => ({
      ...row,
      created_at: row.created_at || null
    }));
  } catch (err) {
    logger.error('[DigitalTwinService] getStoredSimulations failed', {
      userId,
      err: err.message
    });
    throw err;
  }
}

/**
 * invalidateUserCache(userId, role?)
 *
 * Bust the cache for a user (e.g. after they update their profile).
 * If role is omitted, only a specific key cannot be computed — pass role
 * or call engine.invalidateCache() for a global flush.
 *
 * @param {string}  userId
 * @param {string}  [role]
 * @returns {Promise<void>}
 */
async function invalidateUserCache(userId, role) {
  if (!role) return; // can't bust without a key
  const key = _cacheKey(userId, role);
  try {
    const cache = cacheManager.getClient();
    await cache.delete(key);
    logger.info('[DigitalTwinService] User cache invalidated', { userId, key });
  } catch (err) {
    logger.warn('[DigitalTwinService] Cache invalidation failed (non-fatal)', {
      err: err.message
    });
  }
}

module.exports = {
  runSimulation,
  getStoredSimulations,
  invalidateUserCache
};