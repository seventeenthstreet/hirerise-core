'use strict';

/**
 * semanticSkill.engine.js — Semantic Skill Intelligence Engine
 *
 * UPGRADE 1 — extends SkillGraphEngine with vector embedding support.
 *
 * Replaces keyword-based skill comparison with cosine similarity over
 * OpenAI text-embedding-3-small vectors stored in Supabase pgvector.
 *
 * Public API:
 *   generateSkillEmbedding(skillName)  → stores vector, returns row
 *   findSimilarSkills(skillName, opts) → top-k related skills by cosine sim
 *   batchGenerateEmbeddings(skills[])  → bulk upsert (used at import time)
 *
 * Integration points:
 *   - skillGraphEngine.service.js calls findSimilarSkills() as fallback
 *     when no graph relationship exists between two skills.
 *   - SemanticJobMatchingEngine uses this to build user skill vectors.
 *
 * Caching:
 *   - Redis key  : semantic:skill:<normalised_name>
 *   - TTL        : 10 minutes (CACHE_TTL_SECONDS)
 *   - Warm-up    : embedding is generated once then served from DB + Redis
 *
 * @module src/engines/semanticSkill.engine
 */

const cacheManager  = require('../core/cache/cache.manager');
const supabase      = require('../core/supabaseClient');
const logger        = require('../utils/logger');

// ─── Config ───────────────────────────────────────────────────────────────────

const CACHE_TTL_SECONDS  = 600;              // 10 minutes
const EMBEDDING_MODEL    = 'text-embedding-3-small';
const EMBEDDING_DIMS     = 1536;
const DEFAULT_TOP_K      = 5;
const DEFAULT_MIN_SCORE  = 0.60;             // cosine similarity threshold

const cache = cacheManager.getClient();

// ─── OpenAI client (lazy) ─────────────────────────────────────────────────────

let _openai = null;
function getOpenAI() {
  if (_openai) return _openai;
  const OpenAI = require('openai');
  _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalise skill name for consistent cache keys.
 * "Power BI" → "power bi",  "Node.JS" → "node.js"
 */
function normalise(name) {
  return String(name).toLowerCase().trim();
}

/**
 * Redis cache wrapper.
 */
async function _cached(key, ttl, fn) {
  try {
    const hit = await cache.get(key);
    if (hit) return JSON.parse(hit);
  } catch (_) { /* cache miss */ }

  const result = await fn();

  try {
    await cache.set(key, JSON.stringify(result), 'EX', ttl);
  } catch (_) { /* non-fatal */ }

  return result;
}

/**
 * Call OpenAI Embeddings API for a single text string.
 * Returns Float64Array of EMBEDDING_DIMS dimensions.
 */
async function _callEmbeddingAPI(text) {
  const openai   = getOpenAI();
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text.slice(0, 2000),   // API token limit guard
  });
  return response.data[0].embedding;   // number[]
}

// ─── generateSkillEmbedding ───────────────────────────────────────────────────

/**
 * Generate and persist an embedding vector for a skill.
 *
 * 1. Check if vector already exists in skill_embeddings (idempotent).
 * 2. If not, call OpenAI, upsert into Supabase.
 * 3. Warm the Redis cache.
 *
 * @param {string} skillName
 * @returns {Promise<{ skill_name: string, embedding_vector: number[] }>}
 */
async function generateSkillEmbedding(skillName) {
  if (!skillName || typeof skillName !== 'string') {
    throw new Error('generateSkillEmbedding: skillName must be a non-empty string');
  }

  const norm = normalise(skillName);
  const cacheKey = `semantic:skill:embed:${norm}`;

  // 1. Redis fast path
  try {
    const cached = await cache.get(cacheKey);
    if (cached) {
      logger.debug('[SemanticSkillEngine] embedding cache hit', { skillName });
      return JSON.parse(cached);
    }
  } catch (_) {}

  // 2. Check Supabase — might already exist
  const { data: existing } = await supabase
    .from('skill_embeddings')
    .select('skill_name, embedding_vector')
    .ilike('skill_name', norm)
    .maybeSingle();

  if (existing) {
    try { await cache.set(cacheKey, JSON.stringify(existing), 'EX', CACHE_TTL_SECONDS); } catch (_) {}
    return existing;
  }

  // 3. Generate via OpenAI
  logger.info('[SemanticSkillEngine] generating embedding', { skillName });
  const vector = await _callEmbeddingAPI(skillName);

  // 4. Upsert into Supabase
  const row = { skill_name: skillName, embedding_vector: vector };
  const { error } = await supabase
    .from('skill_embeddings')
    .upsert(row, { onConflict: 'skill_name' });

  if (error) {
    logger.error('[SemanticSkillEngine] upsert failed', { skillName, error: error.message });
    throw new Error(`Failed to store embedding for "${skillName}": ${error.message}`);
  }

  // 5. Cache result
  const result = { skill_name: skillName, embedding_vector: vector };
  try { await cache.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL_SECONDS); } catch (_) {}

  logger.info('[SemanticSkillEngine] embedding stored', { skillName });
  return result;
}

// ─── findSimilarSkills ────────────────────────────────────────────────────────

/**
 * Find the top-K skills most semantically similar to the input skill.
 *
 * Uses pgvector cosine similarity via the `find_similar_skills` SQL function
 * defined in the migration.
 *
 * @param {string} skillName
 * @param {{ topK?: number, minScore?: number }} opts
 * @returns {Promise<{ skill: string, similar_skills: string[], scores: object[] }>}
 */
async function findSimilarSkills(skillName, opts = {}) {
  const { topK = DEFAULT_TOP_K, minScore = DEFAULT_MIN_SCORE } = opts;
  const norm     = normalise(skillName);
  const cacheKey = `semantic:skill:similar:${norm}:${topK}:${minScore}`;

  return _cached(cacheKey, CACHE_TTL_SECONDS, async () => {
    // Ensure embedding exists (generates if missing)
    const { embedding_vector } = await generateSkillEmbedding(skillName);

    // pgvector similarity search via SQL function
    const { data, error } = await supabase.rpc('find_similar_skills', {
      query_vector: embedding_vector,
      top_k:        topK + 1,     // +1 to account for self-match
      min_score:    minScore,
    });

    if (error) {
      logger.error('[SemanticSkillEngine] similarity search failed', { skillName, error: error.message });
      return { skill: skillName, similar_skills: [], scores: [] };
    }

    // Filter out self, shape output
    const filtered = (data || [])
      .filter(row => normalise(row.skill_name) !== norm)
      .slice(0, topK);

    return {
      skill:          skillName,
      similar_skills: filtered.map(r => r.skill_name),
      scores:         filtered.map(r => ({
        skill:      r.skill_name,
        similarity: parseFloat(Number(r.similarity).toFixed(3)),
      })),
    };
  });
}

// ─── batchGenerateEmbeddings ─────────────────────────────────────────────────

/**
 * Bulk-generate embeddings for an array of skill names.
 * Skips skills that already have an embedding in Supabase.
 * Rate-limited to avoid OpenAI quota exhaustion (10 req/s default).
 *
 * @param {string[]} skills
 * @returns {Promise<{ generated: number, skipped: number, errors: number }>}
 */
async function batchGenerateEmbeddings(skills) {
  if (!Array.isArray(skills) || skills.length === 0) {
    return { generated: 0, skipped: 0, errors: 0 };
  }

  // Fetch existing skill names from DB to avoid duplicate API calls
  const { data: existing } = await supabase
    .from('skill_embeddings')
    .select('skill_name');

  const existingSet = new Set((existing || []).map(r => normalise(r.skill_name)));

  const toGenerate = [...new Set(skills.map(s => s.trim()))]
    .filter(s => s && !existingSet.has(normalise(s)));

  let generated = 0;
  let errors    = 0;
  const skipped  = skills.length - toGenerate.length;

  logger.info('[SemanticSkillEngine] batch embed start', {
    total: skills.length, toGenerate: toGenerate.length, skipped,
  });

  // Process in batches of 20 with 100ms delay between batches
  const BATCH = 20;
  for (let i = 0; i < toGenerate.length; i += BATCH) {
    const chunk = toGenerate.slice(i, i + BATCH);

    await Promise.allSettled(
      chunk.map(async (skill) => {
        try {
          await generateSkillEmbedding(skill);
          generated++;
        } catch (err) {
          logger.warn('[SemanticSkillEngine] batch embed error', { skill, err: err.message });
          errors++;
        }
      })
    );

    if (i + BATCH < toGenerate.length) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  logger.info('[SemanticSkillEngine] batch embed complete', { generated, skipped, errors });
  return { generated, skipped, errors };
}

// ─── getUserSkillVector ───────────────────────────────────────────────────────

/**
 * Build a combined embedding vector for a user's skill set.
 * Returns the centroid (mean) of all skill embedding vectors.
 * Used by SemanticJobMatchingEngine.
 *
 * @param {string[]} userSkills
 * @returns {Promise<number[]>}   — vector of EMBEDDING_DIMS dimensions
 */
async function getUserSkillVector(userSkills) {
  if (!userSkills || userSkills.length === 0) {
    throw new Error('getUserSkillVector: userSkills must be a non-empty array');
  }

  // Fetch stored embeddings for all skills in one DB query
  const { data, error } = await supabase
    .from('skill_embeddings')
    .select('skill_name, embedding_vector')
    .in('skill_name', userSkills);

  if (error) {
    throw new Error(`Failed to fetch skill vectors: ${error.message}`);
  }

  // For skills not yet embedded, generate on-the-fly
  const embeddedNames = new Set((data || []).map(r => normalise(r.skill_name)));
  const missing       = userSkills.filter(s => !embeddedNames.has(normalise(s)));

  const freshEmbeds = await Promise.all(
    missing.map(s => generateSkillEmbedding(s).catch(() => null))
  );

  const allVectors = [
    ...(data || []).map(r => r.embedding_vector),
    ...freshEmbeds.filter(Boolean).map(r => r.embedding_vector),
  ].filter(Boolean);

  if (allVectors.length === 0) {
    throw new Error('No embeddings could be resolved for user skills');
  }

  // Compute centroid
  const centroid = new Array(EMBEDDING_DIMS).fill(0);
  for (const vec of allVectors) {
    for (let i = 0; i < EMBEDDING_DIMS; i++) {
      centroid[i] += vec[i] / allVectors.length;
    }
  }

  return centroid;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  generateSkillEmbedding,
  findSimilarSkills,
  batchGenerateEmbeddings,
  getUserSkillVector,
  EMBEDDING_DIMS,
};









