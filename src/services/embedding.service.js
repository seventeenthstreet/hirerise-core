'use strict';

/**
 * Embedding Service (Production Ready - Mock Embeddings)
 */

require('dotenv').config();

console.log('EMBEDDING SERVICE LOADED');

// ─────────────────────────────────────────────
// 🔹 IMPORTS
// ─────────────────────────────────────────────

const { supabase } = require('../../supabaseClient');
const logger = require('../utils/logger');

// In-memory cache
const localCache = new Map();

// ─────────────────────────────────────────────
// 🔹 FETCH EMBEDDING (MOCK - STABLE)
// ─────────────────────────────────────────────

async function fetchEmbedding(text) {
  const hash = [...text].reduce((a, c) => a + c.charCodeAt(0), 0);

  return Array(384).fill(0).map((_, i) =>
    (Math.sin(hash + i) + 1) / 2
  );
}

// ─────────────────────────────────────────────
// 🔹 ENSURE SINGLE SKILL EMBEDDING
// ─────────────────────────────────────────────

async function ensureSkillEmbedding(skill) {
  if (!skill || typeof skill !== 'string') return null;

  const normalized = skill.trim().toLowerCase();

  if (localCache.has(normalized)) {
    return localCache.get(normalized);
  }

  try {
    const { data: existing } = await supabase
      .from('skill_embeddings')
      .select('embedding')
      .eq('skill_name', normalized)
      .maybeSingle();

    if (existing?.embedding) {
      localCache.set(normalized, existing.embedding);
      return existing.embedding;
    }

    const embedding = await fetchEmbedding(normalized);

    const { error } = await supabase
      .from('skill_embeddings')
      .insert({
        skill_name: normalized,
        embedding
      });

    if (error && error.code !== '23505') {
      throw error;
    }

    localCache.set(normalized, embedding);

    return embedding;

  } catch (err) {
    logger.error('[Embedding] failed', {
      skill: normalized,
      err: err.message
    });

    return null;
  }
}

// ─────────────────────────────────────────────
// 🔹 BATCH PROCESS
// ─────────────────────────────────────────────

async function ensureSkillEmbeddingsBatch(skills = []) {
  if (!Array.isArray(skills) || skills.length === 0) return;

  const uniqueSkills = [
    ...new Set(
      skills
        .filter(Boolean)
        .map(s => s.trim().toLowerCase())
    )
  ];

  const { data: existingRows } = await supabase
    .from('skill_embeddings')
    .select('skill_name')
    .in('skill_name', uniqueSkills);

  const existingSet = new Set(existingRows?.map(r => r.skill_name));

  const missing = uniqueSkills.filter(s => !existingSet.has(s));

  if (missing.length === 0) return;

  logger.info('[Embedding] missing skills', { count: missing.length });

  const BATCH_SIZE = 5;

  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const chunk = missing.slice(i, i + BATCH_SIZE);

    await Promise.all(
      chunk.map(skill => ensureSkillEmbedding(skill))
    );

    await sleep(200);
  }
}

// ─────────────────────────────────────────────
// 🔹 BACKFILL
// ─────────────────────────────────────────────

async function backfillAllSkillEmbeddings() {
  try {
    const { data: rows } = await supabase
      .from('career_opportunity_signals')
      .select('required_skills');

    if (!rows || rows.length === 0) {
      logger.warn('[Embedding] No skills found');
      return;
    }

    const allSkills = [];

    for (const row of rows) {
      if (Array.isArray(row.required_skills)) {
        allSkills.push(...row.required_skills);
      }
    }

    await ensureSkillEmbeddingsBatch(allSkills);

    logger.info('[Embedding] backfill completed');

  } catch (err) {
    logger.error('[Embedding] backfill failed', {
      err: err.message
    });
  }
}

// ─────────────────────────────────────────────
// 🔹 UTILS
// ─────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────

module.exports = {
  ensureSkillEmbedding,
  ensureSkillEmbeddingsBatch,
  backfillAllSkillEmbeddings
};