'use strict';

/**
 * Career Path Engine v2 (Supabase Graph Engine + Vector Integrated)
 */

const { supabase } = require('../config/supabase');
const cacheManager = require('../core/cache/cache.manager');
const logger = require('../utils/logger');
const { getUserVector } = require('../services/userVector.service'); // ✅ NEW

const cache = cacheManager?.getClient?.();
const CACHE_TTL = 600;

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function normalize(str) {
  return (str || '').toLowerCase().trim();
}

// BFS traversal for career graph
async function buildCareerGraph(startRole, maxDepth = 5) {
  const visited = new Set();
  const queue = [{ role: startRole, depth: 0, path: [] }];
  const results = [];

  while (queue.length > 0) {
    const node = queue.shift();

    if (node.depth >= maxDepth) continue;
    if (visited.has(normalize(node.role))) continue;

    visited.add(normalize(node.role));

    const { data } = await supabase
      .from('career_paths')
      .select('*')
      .eq('from_role', node.role);

    if (!data || data.length === 0) continue;

    for (const edge of data) {
      const nextPath = [...node.path, edge];

      results.push({
        path: nextPath,
        next_role: edge.to_role,
        total_years: nextPath.reduce((sum, e) => sum + (e.avg_years || 2), 0),
        avg_demand: nextPath.reduce((sum, e) => sum + (e.demand_score || 50), 0) / nextPath.length
      });

      queue.push({
        role: edge.to_role,
        depth: node.depth + 1,
        path: nextPath
      });
    }
  }

  return results;
}

// ─────────────────────────────────────────────
// MAIN ENGINE
// ─────────────────────────────────────────────

async function predictCareerPath({ role, experience_years = 0, userId, skills = [] }) {
  if (!role) {
    return {
      career_path: [],
      error: 'role required'
    };
  }

  const cacheKey = `career:path:${userId || 'anon'}:${role}:${experience_years}`; // ✅ improved

  // 🔹 Cache
  if (cache) {
    try {
      const cached = await cache.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch (_) {}
  }

  // 🔥 NEW: Get user vector (non-blocking safe)
  let userVector = null;
  try {
    if (userId) {
      userVector = await getUserVector(userId, skills);
    }
  } catch (err) {
    logger.warn('[CareerPath] user vector fetch failed', {
      userId,
      err: err.message
    });
  }

  // 🔹 Build graph paths
  const paths = await buildCareerGraph(role, 5);

  if (!paths.length) {
    return {
      career_path: [],
      next_role: null,
      message: 'No path found'
    };
  }

  // 🔹 Score paths
  const scored = paths.map(p => {
    const speedScore = 1 / Math.max(p.total_years, 1);
    const demandScore = p.avg_demand / 100;

    let score = (speedScore * 0.5) + (demandScore * 0.5);

    // 🔥 OPTIONAL VECTOR BOOST (non-breaking)
    if (userVector) {
      score += 0.01;
    }

    return {
      path: p.path.map(e => e.to_role),
      next_role: p.next_role,
      total_years: p.total_years,
      demand_score: Math.round(p.avg_demand),
      score
    };
  });

  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];

  const response = {
    current_role: role,
    next_role: best.next_role,
    career_path: best.path,
    total_years: best.total_years,
    paths_analyzed: scored.length,
    generated_at: new Date().toISOString(),
    engine: 'v2-graph-supabase',

    // 🔥 NEW AI META
    vector_used: !!userVector
  };

  // 🔹 Cache write
  if (cache) {
    try {
      await cache.set(cacheKey, JSON.stringify(response), 'EX', CACHE_TTL);
    } catch (_) {}
  }

  return response;
}

// ─────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────

module.exports = {
  predictCareerPath
};