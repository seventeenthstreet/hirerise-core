'use strict';

/**
 * src/engines/semanticSkill.engine.js
 * Semantic Skill Engine v5
 *
 * Full RPC + Redis cache
 */

const cacheManager = require('../core/cache/cache.manager');
const { supabase } = require('../config/supabase');
const logger = require('../utils/logger');

const CACHE_TTL = 600;
const cache = cacheManager?.getClient?.();

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .trim();
}

function normalizeSkills(input) {
  if (Array.isArray(input)) {
    return input
      .map(normalize)
      .filter(Boolean);
  }

  if (typeof input === 'string') {
    const skill = normalize(input);
    return skill ? [skill] : [];
  }

  return [];
}

function buildCacheKey(skills, topK, minScore) {
  return [
    'skill:rpc',
    skills.slice().sort().join('|'),
    `k:${topK}`,
    `min:${minScore}`,
  ].join(':');
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────
async function findSimilarSkills(input, opts = {}) {
  const {
    topK = 5,
    minScore = 0,
  } = opts;

  const normalizedSkills = normalizeSkills(input);

  if (!normalizedSkills.length) {
    return { similar_skills: [] };
  }

  const cacheKey = buildCacheKey(
    normalizedSkills,
    topK,
    minScore
  );

  // ───────────────────────────────────────────────────────────
  // Cache read
  // ───────────────────────────────────────────────────────────
  if (cache) {
    try {
      const cached = await cache.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (error) {
      logger.warn('[SemanticSkillEngine] Cache read failed', {
        error: error.message,
      });
    }
  }

  let rows = [];

  // ───────────────────────────────────────────────────────────
  // RPC call
  // ───────────────────────────────────────────────────────────
  try {
    const { data, error } = await supabase.rpc(
      'match_skills_semantic',
      {
        input_skills: normalizedSkills,
        top_k: topK,
        min_score: minScore,
      }
    );

    if (error) throw error;

    rows = Array.isArray(data) ? data : [];
  } catch (error) {
    logger.error('[SemanticSkillEngine] RPC failed', {
      skills: normalizedSkills,
      topK,
      minScore,
      error: error.message,
    });

    return {
      similar_skills: [],
      meta: {
        error: 'rpc_failed',
      },
    };
  }

  const response = {
    similar_skills: rows.map((row) => row.skill_name),
    scores: rows.map((row) => ({
      skill: row.skill_name,
      similarity: Number(
        Number(row.similarity || 0).toFixed(3)
      ),
    })),
    meta: {
      engine: 'skill-rpc-v2',
      generated_at: new Date().toISOString(),
      input_skills: normalizedSkills,
    },
  };

  // ───────────────────────────────────────────────────────────
  // Cache write
  // ───────────────────────────────────────────────────────────
  if (cache) {
    try {
      await cache.set(
        cacheKey,
        JSON.stringify(response),
        'EX',
        CACHE_TTL
      );
    } catch (error) {
      logger.warn('[SemanticSkillEngine] Cache write failed', {
        error: error.message,
      });
    }
  }

  return response;
}

module.exports = {
  findSimilarSkills,
};