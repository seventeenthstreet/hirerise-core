'use strict';

/**
 * @file src/services/embedding.service.js
 * @description
 * Deterministic mock embedding service.
 *
 * Optimized for:
 * - correct Supabase client import
 * - concurrency-safe upserts
 * - normalized skill caching
 * - batch-safe processing
 * - cleaner observability
 */

const { supabase } = require('../config/supabase');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────
const VECTOR_DIMENSION = 384;
const DEFAULT_BATCH_SIZE = 10;
const BATCH_DELAY_MS = 100;

// lightweight in-memory hot cache
const localCache = new Map();

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function normalizeSkill(skill) {
  return String(skill || '').trim().toLowerCase();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createMockEmbedding(text) {
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
    return null;
  }

  const cached = localCache.get(normalized);
  if (cached) {
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

    const embedding = createMockEmbedding(normalized);

    const { error: upsertError } = await supabase
      .from('skill_embeddings')
      .upsert(
        {
          skill_name: normalized,
          embedding,
        },
        {
          onConflict: 'skill_name',
        }
      );

    if (upsertError) {
      throw upsertError;
    }

    localCache.set(normalized, embedding);

    return embedding;
  } catch (err) {
    logger.error('[EmbeddingService] ensureSkillEmbedding failed', {
      skill_name: normalized,
      error: err?.message || 'Unknown embedding error',
    });

    return null;
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
    ...new Set(
      skills
        .map(normalizeSkill)
        .filter(Boolean)
    ),
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