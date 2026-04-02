'use strict';

/**
 * Career Opportunity Engine v2 (Supabase + ML Ready + Vector Integrated)
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

function computeSkillMatch(userSkills, requiredSkills) {
  if (!requiredSkills || requiredSkills.length === 0) return 0.5;

  const userSet = new Set(userSkills.map(normalize));
  const match = requiredSkills.filter(s => userSet.has(normalize(s))).length;

  return match / requiredSkills.length;
}

function scoreOpportunity({ skillMatch, demand, growth, salary }) {
  return (
    skillMatch * 0.4 +
    demand     * 0.2 +
    growth     * 0.2 +
    (salary/50)* 0.2
  );
}

// ─────────────────────────────────────────────
// MAIN ENGINE
// ─────────────────────────────────────────────

async function analyzeCareerOpportunities(userProfile) {
  const {
    role,
    skills = [],
    experience_years = 0,
    top_n = 5,
    userId // ✅ NEW (optional)
  } = userProfile || {};

  if (!role) {
    return {
      opportunities: [],
      insights: ['role is required'],
      meta: { error: 'missing_role' }
    };
  }

  const cacheKey = `career:opp:${userId || 'anon'}:${role}:${skills.join(',')}`; // ✅ improved

  // 🔹 Redis Cache
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
    logger.warn('[Opportunity] user vector fetch failed', {
      userId,
      err: err.message
    });
  }

  // 🔹 Fetch transitions
  const { data: transitions } = await supabase
    .from('career_paths')
    .select('*')
    .eq('from_role', role);

  if (!transitions || transitions.length === 0) {
    return {
      opportunities: [],
      insights: [`No transitions found for ${role}`],
      meta: {}
    };
  }

  const roles = transitions.map(t => t.to_role);

  // 🔹 Fetch market data
  const { data: marketRows } = await supabase
    .from('role_market_data')
    .select('*')
    .in('role', roles);

  const marketMap = {};
  (marketRows || []).forEach(r => marketMap[r.role] = r);

  // 🔹 Compute opportunities
  const results = transitions.map(t => {
    const market = marketMap[t.to_role] || {};
    const requiredSkills = t.required_skills || [];

    const skillMatch = computeSkillMatch(skills, requiredSkills);

    const demand = (market.demand_score || 50) / 100;
    const growth = (market.growth_score || 50) / 100;
    const salary = market.avg_salary_lpa || 10;

    let score = scoreOpportunity({
      skillMatch,
      demand,
      growth,
      salary
    });

    // 🔥 OPTIONAL VECTOR BOOST (non-breaking, small weight)
    if (userVector) {
      score += 0.02; // tiny boost (future: replace with real vector similarity)
    }

    return {
      role: t.to_role,
      match_score: Math.round(score * 100),
      skill_match: parseFloat(skillMatch.toFixed(2)),
      demand_score: market.demand_score || 50,
      growth_score: market.growth_score || 50,
      salary_lpa: salary,
      required_skills: requiredSkills
    };
  });

  // 🔹 Rank
  results.sort((a, b) => b.match_score - a.match_score);

  const topResults = results.slice(0, top_n);

  // 🔹 Insights
  const insights = topResults.length > 0
    ? [`Top opportunity: ${topResults[0].role} (${topResults[0].match_score}% match)`]
    : ['No strong matches found'];

  const response = {
    opportunities: topResults,
    insights,
    meta: {
      role,
      total: results.length,
      generated_at: new Date().toISOString(),
      engine: 'v2-supabase-ml',

      // 🔥 NEW AI META
      vector_used: !!userVector
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

// ─────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────

module.exports = {
  analyzeCareerOpportunities
};