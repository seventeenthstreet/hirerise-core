'use strict';

/**
 * Career Opportunity Engine v3 (career_role_transitions + CareerGraph integrated)
 *
 * WP-CI-02: migrated off the retired `career_paths` model. Reads now go
 * through `career_role_transitions` (via CareerGraph.js for graph traversal)
 * plus `career_roles` / `career_skills_registry` for role and skill detail
 * that previously lived in `role_market_data`.
 */

const crypto = require('crypto');
const { supabase } = require('../config/supabase');
const cacheManager = require('../core/cache/cache.manager');
// Phase 2: lazy getter — resolves Redis post-bootstrap on each call
const getCache = () => cacheManager?.getClient?.() || null;
const logger = require('../utils/logger');
const { getUserVector } = require('../services/userVector.utils'); // ✅ NEW
const careerGraph = require('../modules/careerGraph/CareerGraph');

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

const ROLE_SELECT = 'role_id, role_name, demand_score, salary_data';

// Builds the skills segment of the cache key. Two request bodies with the
// same skills in a different order (or different casing) score identically
// via computeSkillMatch()'s own normalization, but `skills.join(',')` alone
// would still treat them as different keys — sorting+normalizing here avoids
// that needless cache fragmentation. Skills are validated to at most 100
// items x 150 chars upstream (career-opportunity.routes.js), so the joined
// string can still get long; it's hashed past a bounded length so cache keys
// stay a predictable size instead of growing unbounded with the payload.
const SKILLS_KEY_INLINE_LIMIT = 200;

function buildSkillsKeyPart(skills) {
  const joined = [...new Set(skills.map(normalize).filter(Boolean))]
    .sort()
    .join(',');

  if (joined.length <= SKILLS_KEY_INLINE_LIMIT) return joined;

  return crypto.createHash('sha1').update(joined).digest('hex');
}

// Resolves a free-text role title (legacy `career_paths.from_role`/`to_role`
// shape, e.g. "Software Engineer") — or an already-normalized role_id — to a
// `career_roles` node. CareerGraph.resolveRole()/searchRoles() can't be reused
// here: they filter on a `title` column that does not exist on `career_roles`
// (see repository findings), so resolution is done directly against the
// documented schema columns (`role_id`, `normalized_name`, `role_name`).
async function resolveRoleNode(roleInput) {
  const normalized = normalize(roleInput);
  if (!normalized) return null;

  try {
    const { data: byId, error: byIdErr } = await supabase
      .from('career_roles')
      .select(ROLE_SELECT)
      .eq('role_id', normalized)
      .maybeSingle();
    if (byIdErr) {
      logger.warn('[Opportunity] role lookup by id failed', {
        role: roleInput,
        err: byIdErr.message
      });
    } else if (byId) {
      return byId;
    }

    const { data: byNormalizedName, error: byNameErr } = await supabase
      .from('career_roles')
      .select(ROLE_SELECT)
      .eq('normalized_name', normalized)
      .maybeSingle();
    if (byNameErr) {
      logger.warn('[Opportunity] role lookup by normalized_name failed', {
        role: roleInput,
        err: byNameErr.message
      });
    } else if (byNormalizedName) {
      return byNormalizedName;
    }

    const { data: fuzzy, error: fuzzyErr } = await supabase
      .from('career_roles')
      .select(ROLE_SELECT)
      .ilike('role_name', `%${roleInput}%`)
      .limit(1);
    if (fuzzyErr) {
      logger.warn('[Opportunity] fuzzy role lookup failed', {
        role: roleInput,
        err: fuzzyErr.message
      });
      return null;
    }

    return fuzzy?.[0] || null;
  } catch (err) {
    logger.warn('[Opportunity] role resolution failed', {
      role: roleInput,
      err: err.message
    });
    return null;
  }
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

  const cacheKey = `career:opp:${userId || 'anon'}:${role}:${buildSkillsKeyPart(skills)}`; // ✅ improved

  // 🔹 Redis Cache
  const cache = getCache();
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

  // 🔹 Resolve the starting role to a career_roles graph node
  const fromRole = await resolveRoleNode(role);

  if (!fromRole) {
    return {
      opportunities: [],
      insights: [`No transitions found for ${role}`],
      meta: {}
    };
  }

  // 🔹 Fetch transitions (career_role_transitions, via CareerGraph)
  let transitions = [];
  try {
    transitions = await careerGraph.getTransitions(fromRole.role_id);
  } catch (err) {
    logger.warn('[Opportunity] transitions fetch failed', {
      role,
      roleId: fromRole.role_id,
      err: err.message
    });
  }

  if (!transitions || transitions.length === 0) {
    return {
      opportunities: [],
      insights: [`No transitions found for ${role}`],
      meta: {}
    };
  }

  // 🔹 Fetch destination role detail (replaces role_market_data lookup)
  const toRoleIds = [...new Set(transitions.map(t => t.to_role_id))];

  const { data: roleRows, error: roleRowsErr } = await supabase
    .from('career_roles')
    .select(ROLE_SELECT)
    .in('role_id', toRoleIds);

  if (roleRowsErr) {
    logger.warn('[Opportunity] destination role fetch failed', {
      role,
      toRoleIds,
      err: roleRowsErr.message
    });
  }

  const roleMap = {};
  (roleRows || []).forEach(r => { roleMap[r.role_id] = r; });

  // 🔹 Resolve required_skills (skill_id[] on career_role_transitions) to
  // display names via career_skills_registry, mirroring CareerGraph.getSkillsForRole
  const skillIdSet = new Set();
  transitions.forEach(t => (t.required_skills || []).forEach(id => skillIdSet.add(id)));

  const skillNameMap = {};
  if (skillIdSet.size > 0) {
    const { data: skillRows, error: skillRowsErr } = await supabase
      .from('career_skills_registry')
      .select('skill_id, skill_name')
      .in('skill_id', [...skillIdSet]);

    if (skillRowsErr) {
      logger.warn('[Opportunity] skill registry fetch failed', {
        role,
        skillIds: [...skillIdSet],
        err: skillRowsErr.message
      });
    }

    (skillRows || []).forEach(s => { skillNameMap[s.skill_id] = s.skill_name; });
  }

  // 🔹 Compute opportunities
  const results = transitions.map(t => {
    const destRole = roleMap[t.to_role_id] || {};
    const requiredSkillIds = t.required_skills || [];
    const requiredSkills = requiredSkillIds.map(id => skillNameMap[id] || id);

    const skillMatch = computeSkillMatch(skills, requiredSkills);

    // demand: prefer the destination role's own demand_score (closest analog
    // to legacy role_market_data.demand_score), falling back to the
    // transition-level demand_score when the role row wasn't found.
    const demand = (destRole.demand_score ?? t.demand_score ?? 50) / 100;

    // growth: career_role_transitions/career_roles carry no equivalent to
    // legacy role_market_data.growth_score (see repository findings) — no
    // such metric exists anywhere in the modern model. A neutral 0.5 is used,
    // matching the fallback the original engine already applied whenever
    // market data for a role was missing, so scoring keeps the same shape.
    const growth = 0.5;

    // salary: career_roles.salary_data.median is stored as an absolute INR
    // figure (see career-graph seed data); convert to LPA to match the
    // existing salary_lpa scale (avg_salary_lpa was already lakhs/year).
    const rawSalary = destRole.salary_data?.median;
    const salary = typeof rawSalary === 'number' ? rawSalary / 100000 : 10;

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
      role: destRole.role_name || t.to_role_id,
      match_score: Math.round(score * 100),
      skill_match: parseFloat(skillMatch.toFixed(2)),
      demand_score: Math.round(demand * 100),
      growth_score: Math.round(growth * 100),
      salary_lpa: Math.round(salary * 100) / 100,
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
      engine: 'v3-career-role-transitions',

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
