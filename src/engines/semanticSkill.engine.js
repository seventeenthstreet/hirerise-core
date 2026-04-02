'use strict';

/**
 * Semantic Skill Engine v4 (FULL RPC - NO NODE VECTOR LOGIC)
 */

const cacheManager = require('../core/cache/cache.manager');
const { supabase } = require('../config/supabase');
const logger = require('../utils/logger');

const CACHE_TTL = 600;
const cache = cacheManager?.getClient?.();

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function normalize(str) {
  return (str || '').toLowerCase().trim();
}

function buildCacheKey(skills, topK) {
  return `skill:rpc:${skills.map(normalize).sort().join('|')}:${topK}`;
}

// ─────────────────────────────────────────────
// MAIN FUNCTION (RPC ONLY)
// ─────────────────────────────────────────────

async function findSimilarSkills(skills, opts = {}) {
  const { topK = 5 } = opts;

  if (!Array.isArray(skills) || skills.length === 0) {
    return { similar_skills: [] };
  }

  const normalizedSkills = skills.map(normalize);
  const cacheKey = buildCacheKey(normalizedSkills, topK);

  // 🔹 Cache
  if (cache) {
    try {
      const cached = await cache.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch (_) {}
  }

  // 🔹 RPC CALL (DB DOES EVERYTHING)
  let data = [];

  try {
    const res = await supabase.rpc('match_skills_semantic', {
      input_skills: normalizedSkills,
      top_k: topK
    });

    if (res.error) throw res.error;

    data = res.data || [];
  } catch (err) {
    logger.error('[Skill RPC] failed', { err: err.message });

    return {
      similar_skills: [],
      meta: { error: 'rpc_failed' }
    };
  }

  const response = {
    similar_skills: data.map(d => d.skill_name),
    scores: data.map(d => ({
      skill: d.skill_name,
      similarity: Number((d.similarity || 0).toFixed(3))
    })),
    meta: {
      engine: 'skill-rpc-v1',
      generated_at: new Date().toISOString()
    }
  };

  // 🔹 Cache write
  if (cache) {
    try {
      await cache.set(cacheKey, JSON.stringify(response), 'EX', CACHE_TTL);
    } catch (_) {}
  }

  return response;
}

module.exports = {
  findSimilarSkills
};