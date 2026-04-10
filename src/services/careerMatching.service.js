'use strict';

/**
 * @file src/services/careerMatching.service.js
 * @description
 * Wave 3 Priority #2 — Supabase RPC consolidation.
 *
 * Production-safe CHI scoring + role matching service.
 *
 * Verified production DB contract:
 * - cms_roles.domain_id = text
 * - cms_roles.job_family_id = text
 * - chi_scores.user_id = text
 * - chi_scores.role_id = text
 * - upsert_chi_score write path uses uuid params
 * - get_chi_score read path uses text params
 */

const logger = require('../utils/logger');
const careerGraph = require('../modules/careerGraph/CareerGraph');
const { supabase } = require('../config/supabase');

const RPC = Object.freeze({
  LEARNING_PROGRESS: 'compute_learning_progress',
  DOMAIN_FAMILY_IDS: 'resolve_family_ids_for_domain',
  MATCH_CAREER_ROLES: 'match_career_roles',
  UPSERT_CHI_SCORE: 'upsert_chi_score',
  GET_CHI_SCORE: 'get_chi_score',
});

// ─────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────
async function executeRpc(fn, params = {}, { allowFallback = false } = {}) {
  const startedAt = Date.now();

  try {
    const { data, error } = await supabase.rpc(fn, params);

    if (error) {
      error.rpc = fn;
      throw error;
    }

    logger.debug('[CareerMatching][RPC] success', {
      rpc: fn,
      latency_ms: Date.now() - startedAt,
    });

    return data;
  } catch (error) {
    logger.warn('[CareerMatching][RPC] failed', {
      rpc: fn,
      latency_ms: Date.now() - startedAt,
      error: error?.message || 'Unknown RPC error',
      fallback_enabled: allowFallback,
    });

    if (!allowFallback) throw error;
    return null;
  }
}

function normalizeSkills(skills) {
  return new Set(
    (Array.isArray(skills) ? skills : [])
      .map((s) => String(s).toLowerCase().trim())
      .filter(Boolean)
  );
}

function safeNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// ─────────────────────────────────────────────────────────────
// Learning Progress
// ─────────────────────────────────────────────────────────────
async function computeLearningProgress(userId) {
  const safeUserId = String(userId || '').trim();
  if (!safeUserId) return 0;

  try {
    const rpcResult = await executeRpc(
      RPC.LEARNING_PROGRESS,
      { p_user_id: safeUserId },
      { allowFallback: true }
    );

    if (rpcResult !== null && rpcResult !== undefined) {
      return clamp(safeNumber(rpcResult, 0), 0, 100);
    }

    const thirtyDaysAgo = new Date(
      Date.now() - 30 * 86400000
    ).toISOString();

    const { data, error } = await supabase
      .from('activity_events')
      .select('event_type')
      .eq('user_id', safeUserId)
      .gte('created_at', thirtyDaysAgo)
      .in('event_type', ['skill_added', 'course_started']);

    if (error) throw error;

    let skillsAdded = 0;
    let coursesStarted = 0;

    for (const row of data || []) {
      if (row.event_type === 'skill_added') skillsAdded += 1;
      if (row.event_type === 'course_started') coursesStarted += 1;
    }

    const score = Math.round(
      clamp(skillsAdded / 5, 0, 1) * 50 +
      clamp(coursesStarted / 3, 0, 1) * 50
    );

    return clamp(score, 0, 100);
  } catch (err) {
    logger.warn('[CareerMatching] computeLearningProgress failed', {
      user_id: safeUserId,
      error: err?.message || 'Unknown progress error',
    });

    return 0;
  }
}

// ─────────────────────────────────────────────────────────────
// Role Scoring
// ─────────────────────────────────────────────────────────────
function calculateRoleScore(profile = {}, role = {}, learningProgress = 0) {
  const profileSkills = normalizeSkills(profile.skills);

  const requiredSkills = (
    Array.isArray(role.required_skills)
      ? role.required_skills
      : []
  )
    .map((s) => String(s).toLowerCase().trim())
    .filter(Boolean);

  const matched = requiredSkills.filter((s) =>
    profileSkills.has(s)
  ).length;

  const skillMatch = requiredSkills.length
    ? Math.round((matched / requiredSkills.length) * 100)
    : 0;

  const years = safeNumber(profile.experience_years, 0);
  const expMin = safeNumber(role.experience_min, 0);
  const expMax = safeNumber(role.experience_max, 20);

  let experienceFit = 0;

  if (years >= expMin && years <= expMax) {
    experienceFit = 100;
  } else if (years < expMin) {
    experienceFit = clamp(100 - (expMin - years) * 20, 0, 100);
  } else {
    experienceFit = clamp(100 - (years - expMax) * 10, 0, 100);
  }

  const marketDemand = clamp(
    Math.round((safeNumber(role.market_demand, 5) / 10) * 100),
    0,
    100
  );

  const safeLearning = clamp(learningProgress, 0, 100);

  const chiScore = Math.round(
    skillMatch * 0.4 +
    experienceFit * 0.3 +
    marketDemand * 0.2 +
    safeLearning * 0.1
  );

  return {
    skillMatch,
    experienceFit,
    marketDemand,
    learningProgress: safeLearning,
    chiScore,
    insights: {
      missingSkills: requiredSkills.filter(
        (s) => !profileSkills.has(s)
      ),
      experienceGap: years < expMin ? expMin - years : 0,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Domain family resolution
// ─────────────────────────────────────────────────────────────
async function resolveFamilyIdsForDomain(domainId) {
  if (!domainId) return null;

  const rpcResult = await executeRpc(
    RPC.DOMAIN_FAMILY_IDS,
    {
      p_domain_id: String(domainId),
    },
    { allowFallback: true }
  );

  if (Array.isArray(rpcResult)) return rpcResult;

  const { data, error } = await supabase
    .from('cms_roles')
    .select('job_family_id')
    .eq('domain_id', String(domainId))
    .eq('soft_deleted', false)
    .not('job_family_id', 'is', null);

  if (error) {
    logger.error('[CareerMatching] resolveFamilyIdsForDomain failed', {
      domain_id: domainId,
      error: error.message,
    });
    return null;
  }

  return [...new Set((data || []).map((r) => r.job_family_id))];
}

// ─────────────────────────────────────────────────────────────
// Role Matching
// ─────────────────────────────────────────────────────────────
async function matchCareerRoles(profile = {}, domainId, { limit = 10 } = {}) {
  try {
    const safeLimit = clamp(Number(limit) || 10, 1, 50);

    const learningProgress = profile.userId
      ? await computeLearningProgress(profile.userId)
      : 0;

    const rpcRows = await executeRpc(
      RPC.MATCH_CAREER_ROLES,
      {
        p_domain_id: domainId ? String(domainId) : null,
        p_limit: safeLimit,
      },
      { allowFallback: true }
    );

    let roles = Array.isArray(rpcRows) ? rpcRows : null;

    if (!roles) {
      let query = supabase
        .from('cms_roles')
        .select(`
          id,
          name,
          required_skills,
          experience_min,
          experience_max,
          market_demand
        `)
        .eq('soft_deleted', false)
        .eq('status', 'active')
        .order('market_demand', { ascending: false });

      if (domainId) {
        query = query.eq('domain_id', String(domainId));
      }

      const { data, error } = await query;
      if (error) throw error;

      roles = data || [];
    }

    return roles
      .map((role) => ({
        role,
        scores: calculateRoleScore(profile, role, learningProgress),
      }))
      .sort((a, b) => b.scores.chiScore - a.scores.chiScore)
      .slice(0, safeLimit)
      .map((item, idx) => ({
        ...item,
        rank: idx + 1,
      }));
  } catch (err) {
    logger.error('[CareerMatchingService] matchCareerRoles failed', {
      error: err?.message || 'Unknown matching error',
    });

    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// CHI persistence
// ─────────────────────────────────────────────────────────────
async function saveChiScore(userId, roleId, breakdown) {
  try {
    const rpcResult = await executeRpc(
      RPC.UPSERT_CHI_SCORE,
      {
        p_user_id: userId, // keep raw UUID
        p_role_id: roleId, // keep raw UUID
        p_skill_match: breakdown.skillMatch,
        p_experience_fit: breakdown.experienceFit,
        p_market_demand: breakdown.marketDemand,
        p_learning_progress: breakdown.learningProgress,
        p_chi_score: breakdown.chiScore,
      },
      { allowFallback: true }
    );

    if (rpcResult?.id) return rpcResult;

    const payload = {
      id: `${userId}_${roleId}`,
      user_id: String(userId),
      role_id: String(roleId),
      skill_match: breakdown.skillMatch,
      experience_fit: breakdown.experienceFit,
      market_demand: breakdown.marketDemand,
      learning_progress: breakdown.learningProgress,
      chi_score: breakdown.chiScore,
      last_updated: new Date().toISOString(),
    };

    const { error } = await supabase
      .from('chi_scores')
      .upsert(payload, { onConflict: 'id' });

    if (error) throw error;

    return { id: payload.id };
  } catch (err) {
    logger.error('[CareerMatchingService] saveChiScore failed', {
      error: err?.message || 'Unknown save error',
    });
    throw err;
  }
}

async function getChiScore(userId, roleId) {
  try {
    const rpcResult = await executeRpc(
      RPC.GET_CHI_SCORE,
      {
        p_user_id: String(userId),
        p_role_id: String(roleId),
      },
      { allowFallback: true }
    );

    if (rpcResult) return rpcResult;

    const { data, error } = await supabase
      .from('chi_scores')
      .select('*')
      .eq('id', `${userId}_${roleId}`)
      .maybeSingle();

    if (error) throw error;

    return data || null;
  } catch (err) {
    logger.error('[CareerMatchingService] getChiScore failed', {
      error: err?.message || 'Unknown fetch error',
    });

    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Graph-based CHI
// ─────────────────────────────────────────────────────────────
function computeGraphCHIForRole(profile = {}) {
  if (!profile.targetRoleId && !profile.targetRoleName) {
    return null;
  }

  const p = { ...profile };

  if (!p.targetRoleId && p.targetRoleName) {
    const node = careerGraph.resolveRole(p.targetRoleName);
    if (node) p.targetRoleId = node.role_id;
  }

  if (!p.currentRoleId && p.currentRoleName) {
    const node = careerGraph.resolveRole(p.currentRoleName);
    if (node) p.currentRoleId = node.role_id;
  }

  if (!p.targetRoleId) return null;

  return careerGraph.computeCHI(p);
}

module.exports = {
  computeLearningProgress,
  calculateRoleScore,
  matchCareerRoles,
  saveChiScore,
  getChiScore,
  computeGraphCHIForRole,
};