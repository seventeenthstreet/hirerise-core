'use strict';

/**
 * @file src/services/careerMatching.service.js
 * @description
 * Production-safe CHI scoring + role matching service.
 *
 * Optimized for:
 * - snake_case Supabase schema
 * - stronger null safety
 * - deterministic ordering
 * - safer upserts
 * - reusable normalization helpers
 * - lower overfetch
 *
 * Schema fixes applied:
 * - domain_id resolved via cms_job_families (not directly on cms_roles)
 * - removed camelCase fallbacks — schema is fully snake_case
 * - market_demand, required_skills, experience_min/max now exist on cms_roles
 */

const logger = require('../utils/logger');
const careerGraph = require('../modules/careerGraph/CareerGraph');
const { supabase } = require('../config/supabase');

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
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
    const thirtyDaysAgo = new Date(
      Date.now() - 30 * 86400000
    ).toISOString();

    let skillsAdded = 0;
    let coursesStarted = 0;

    let from = 0;
    const pageSize = 500;

    while (true) {
      const { data, error } = await supabase
        .from('activity_events')
        .select('event_type')
        .eq('user_id', safeUserId)
        .gte('created_at', thirtyDaysAgo)
        .in('event_type', ['skill_added', 'course_started'])
        .order('created_at', { ascending: false })
        .range(from, from + pageSize - 1);

      if (error) throw error;
      if (!data?.length) break;

      for (const row of data) {
        if (row.event_type === 'skill_added') skillsAdded += 1;
        else if (row.event_type === 'course_started') coursesStarted += 1;
      }

      if (data.length < pageSize) break;
      from += pageSize;
    }

    try {
      const { data, error } = await supabase
        .from('ava_memory')
        .select('skills_added')
        .eq('user_id', safeUserId)
        .limit(1)
        .maybeSingle();

      if (!error && data) {
        const weekly = safeNumber(data.skills_added, 0);
        const estimatedMonthly = Math.round(weekly * 2);
        skillsAdded += Math.round(estimatedMonthly * 0.5);
      }
    } catch (_) {
      // intentionally non-blocking
    }

    const skillComponent = clamp(skillsAdded / 5, 0, 1) * 50;
    const courseComponent = clamp(coursesStarted / 3, 0, 1) * 50;

    const result = Math.round(
      clamp(skillComponent + courseComponent, 0, 100)
    );

    logger.debug('[CareerMatching] Learning progress computed', {
      user_id: safeUserId,
      skills_added: skillsAdded,
      courses_started: coursesStarted,
      learning_progress: result,
    });

    return result;
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

  // Schema is fully snake_case — no camelCase fallbacks needed
  const requiredSkills = (
    Array.isArray(role.required_skills) ? role.required_skills : []
  )
    .map((s) => String(s).toLowerCase().trim())
    .filter(Boolean);

  let skillMatch = 0;

  if (requiredSkills.length > 0) {
    const matched = requiredSkills.filter((s) =>
      profileSkills.has(s)
    ).length;

    skillMatch = Math.round((matched / requiredSkills.length) * 100);
  }

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

  const rawDemand = safeNumber(role.market_demand, 5);
  const marketDemand = clamp(Math.round((rawDemand / 10) * 100), 0, 100);
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
      missingSkills: requiredSkills.filter((s) => !profileSkills.has(s)),
      experienceGap: years < expMin ? expMin - years : 0,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Domain → job family ID resolution
// cms_roles has no domain_id column directly —
// domain maps via cms_roles.job_family_id → cms_job_families.domain_id
// ─────────────────────────────────────────────────────────────
async function resolveFamilyIdsForDomain(domainId) {
  const { data, error } = await supabase
    .from('cms_job_families')
    .select('id')
    .eq('domain_id', domainId)
    .eq('soft_deleted', false);

  if (error) {
    logger.error('[CareerMatching] resolveFamilyIdsForDomain failed', {
      domain_id: domainId,
      error: error.message,
    });
    return null;
  }

  return (data ?? []).map((f) => f.id);
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

    // Resolve domainId → job_family_ids
    // domain_id does not exist on cms_roles — must join via cms_job_families
    let familyIds = null;
    if (domainId) {
      familyIds = await resolveFamilyIdsForDomain(domainId);

      if (!familyIds) {
        // Resolution errored — fail gracefully
        return [];
      }

      if (!familyIds.length) {
        // Valid domain but no families assigned — nothing to match
        logger.debug('[CareerMatching] No job families found for domain', {
          domain_id: domainId,
        });
        return [];
      }
    }

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

    if (familyIds) {
      query = query.in('job_family_id', familyIds);
    }

    const { data, error } = await query;
    if (error) throw error;

    const roles = Array.isArray(data) ? data : [];

    const scored = roles
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

    return scored;
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
    const payload = {
      id: `${userId}_${roleId}`,
      user_id: userId,
      role_id: roleId,
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
    const { data, error } = await supabase
      .from('chi_scores')
      .select(`
        id,
        user_id,
        role_id,
        skill_match,
        experience_fit,
        market_demand,
        learning_progress,
        chi_score,
        last_updated
      `)
      .eq('id', `${userId}_${roleId}`)
      .maybeSingle();

    if (error) throw error;
    return data ?? null;
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