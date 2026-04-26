'use strict';

/**
 * @file src/services/embedding.service.js
 * @description
 * Patch 44 production-ready deterministic embedding service.
 *
 * Optimized for:
 * - authoritative vector persistence
 * - normalized skill cache convergence
 * - batch-safe processing
 * - cleaner observability
 *
 * SECURITY FIX: Mock embeddings are DISABLED in production.
 * createMockEmbedding() is retained for development/test only.
 * In production, missing embeddings return null and are skipped
 * rather than persisting fake vectors that corrupt similarity scores.
 */

const { supabase } = require('../config/supabase');
const logger = require('../utils/logger');
const {
  authoritativeUpsert,
} = require('../lib/db/authoritativeMutation');

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────
const VECTOR_DIMENSION = 384;
const DEFAULT_BATCH_SIZE = 10;
const BATCH_DELAY_MS = 100;

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// lightweight in-memory hot cache
const localCache = new Map();

// ─────────────────────────────────────────────────────────────
// Structured fallback — returned instead of raw null in production.
// Callers can check result?.status === 'missing_embedding' and decide
// whether to skip, queue a backfill, or surface a metric.
// ─────────────────────────────────────────────────────────────
const MISSING_EMBEDDING_RESULT = Object.freeze({
  embedding: null,
  status: 'missing_embedding',
});

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function normalizeSkill(skill) {
  return String(skill || '').trim().toLowerCase();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * DEVELOPMENT / TEST ONLY.
 * Produces a deterministic but meaningless vector from a text hash.
 * Must NEVER be called in production — it produces fake similarity scores
 * that corrupt job-match rankings and career intelligence features.
 */
function createMockEmbedding(text) {
  if (IS_PRODUCTION) {
    // Defensive guard — should be unreachable due to call-site check below,
    // but belt-and-suspenders prevents future callers from bypassing it.
    logger.error('[EmbeddingService] createMockEmbedding called in production — blocked', { text });
    return null;
  }

  const normalized = normalizeSkill(text);

  if (!normalized) {
    return null;
  }

  const hash = [...normalized].reduce(
    (acc, char) => acc + char.charCodeAt(0),
    0
  );

  return Array.from({ length: VECTOR_DIMENSION }, (_, i) =>
    (Math.sin(hash + i) + 1) / 2
  );
}

// ─────────────────────────────────────────────────────────────
// Single embedding
// ─────────────────────────────────────────────────────────────
async function ensureSkillEmbedding(skill) {
  const normalized = normalizeSkill(skill);

  if (!normalized) {
    // Invalid input — return structured fallback, not raw null.
    return MISSING_EMBEDDING_RESULT;
  }

  const cached = localCache.get(normalized);
  if (cached) {
    // Cached value is always a real embedding array — return directly.
    return cached;
  }

  try {
    const { data, error } = await supabase
      .from('skill_embeddings')
      .select('embedding')
      .eq('skill_name', normalized)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (data?.embedding) {
      localCache.set(normalized, data.embedding);
      return data.embedding;
    }

    // Production: no real embedding exists — do NOT generate or persist
    // mock vectors. Return structured fallback so callers can distinguish
    // "missing embedding" from an error and log/alert appropriately.
    if (IS_PRODUCTION) {
      logger.warn('[EmbeddingService] No real embedding found in production', {
        skill_name: normalized,
        status: 'missing_embedding',
      });
      return MISSING_EMBEDDING_RESULT;
    }

    // Development / test: generate and persist a deterministic mock embedding.
    const embedding = createMockEmbedding(normalized);

    await authoritativeUpsert({
      table: 'skill_embeddings',
      payload: {
        skill_name: normalized,
        embedding,
      },
      conflictKey: 'skill_name',
      requestKey: normalized,
    });

    localCache.set(normalized, embedding);

    return embedding;
  } catch (err) {
    logger.error('[EmbeddingService] ensureSkillEmbedding failed', {
      skill_name: normalized,
      error: err?.message || 'Unknown embedding error',
      status: 'missing_embedding',
    });

    // Return structured fallback — never raw null — so callers always
    // get a consistent shape and can check result?.status.
    return MISSING_EMBEDDING_RESULT;
  }
}

// ─────────────────────────────────────────────────────────────
// Batch embedding
// ─────────────────────────────────────────────────────────────
async function ensureSkillEmbeddingsBatch(skills = []) {
  if (!Array.isArray(skills) || skills.length === 0) {
    return [];
  }

  const uniqueSkills = [
    ...new Set(skills.map(normalizeSkill).filter(Boolean)),
  ];

  if (!uniqueSkills.length) {
    return [];
  }

  const { data, error } = await supabase
    .from('skill_embeddings')
    .select('skill_name, embedding')
    .in('skill_name', uniqueSkills);

  if (error) {
    logger.error('[EmbeddingService] batch prefetch failed', {
      error: error.message,
    });
    return [];
  }

  const existingSet = new Set();

  for (const row of data || []) {
    existingSet.add(row.skill_name);

    if (row.embedding) {
      localCache.set(row.skill_name, row.embedding);
    }
  }

  const missing = uniqueSkills.filter(
    (skill) => !existingSet.has(skill)
  );

  if (!missing.length) {
    return uniqueSkills;
  }

  logger.info('[EmbeddingService] missing skills', {
    count: missing.length,
  });

  for (let i = 0; i < missing.length; i += DEFAULT_BATCH_SIZE) {
    const chunk = missing.slice(i, i + DEFAULT_BATCH_SIZE);

    await Promise.all(
      chunk.map((skill) => ensureSkillEmbedding(skill))
    );

    if (i + DEFAULT_BATCH_SIZE < missing.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  return uniqueSkills;
}

// ─────────────────────────────────────────────────────────────
// Backfill
// ─────────────────────────────────────────────────────────────
async function backfillAllSkillEmbeddings() {
  try {
    const { data, error } = await supabase
      .from('career_opportunity_signals')
      .select('required_skills');

    if (error) {
      throw error;
    }

    if (!Array.isArray(data) || data.length === 0) {
      logger.warn('[EmbeddingService] No skills found');
      return;
    }

    const allSkills = [];

    for (const row of data) {
      if (Array.isArray(row.required_skills)) {
        allSkills.push(...row.required_skills);
      }
    }

    if (!allSkills.length) {
      logger.warn('[EmbeddingService] No valid required_skills arrays');
      return;
    }

    await ensureSkillEmbeddingsBatch(allSkills);

    logger.info('[EmbeddingService] backfill completed', {
      total_skills: allSkills.length,
    });
  } catch (err) {
    logger.error('[EmbeddingService] backfill failed', {
      error: err?.message || 'Unknown backfill error',
    });
  }
}

module.exports = {
  ensureSkillEmbedding,
  ensureSkillEmbeddingsBatch,
  backfillAllSkillEmbeddings,
};