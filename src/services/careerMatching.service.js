'use strict';

/**
 * careerMatching.service.js — PRODUCTION SAFE VERSION
 *
 * Improvements:
 *  - Pagination (no 200 row cap issue)
 *  - Optimized queries (select only needed fields)
 *  - Safe merging of activity_events + ava_memory
 *  - Normalized skill comparison
 *  - Clean loop performance
 *  - Ready for Redis caching (optional hook included)
 */

const logger = require('../utils/logger');
const careerGraph = require('../modules/careerGraph/CareerGraph');
const { supabase } = require('../config/supabase');

// OPTIONAL: plug Redis here if available
// const redis = require('../config/redis');

// ─────────────────────────────────────────────────────────────
// Learning Progress (Robust + Accurate)
// ─────────────────────────────────────────────────────────────

async function computeLearningProgress(userId) {
  if (!userId) return 0;

  try {
    const cacheKey = `learning_progress:${userId}`;

    // ── Optional Cache Layer ──
    /*
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);
    */

    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();

    let skillsAdded = 0;
    let coursesStarted = 0;

    // ── Pagination (NO DATA LOSS) ──
    let from = 0;
    const pageSize = 500;

    while (true) {
      const { data, error } = await supabase
        .from('activity_events')
        .select('event_type')
        .eq('user_id', userId)
        .gte('created_at', thirtyDaysAgo)
        .range(from, from + pageSize - 1);

      if (error) throw error;
      if (!data || data.length === 0) break;

      for (const { event_type } of data) {
        if (event_type === 'skill_added') skillsAdded++;
        else if (event_type === 'course_started') coursesStarted++;
      }

      if (data.length < pageSize) break;
      from += pageSize;
    }

    // ── Ava Memory (Supplementary Signal) ──
    try {
      const { data: avaRows, error: avaError } = await supabase
        .from('ava_memory')
        .select('skills_added')
        .eq('user_id', userId)
        .limit(1);

      if (!avaError && avaRows && avaRows.length > 0) {
        const weekly = avaRows[0]?.skills_added ?? 0;
        const estimatedMonthly = Math.round(weekly * 2);

        // Merge signals safely (not override)
        skillsAdded += Math.round(estimatedMonthly * 0.5);
      }
    } catch (_) {
      // Non-blocking
    }

    // ── Compute Score ──
    const skillComponent = Math.min(1, skillsAdded / 5) * 50;
    const courseComponent = Math.min(1, coursesStarted / 3) * 50;

    const result = Math.round(
      Math.min(100, Math.max(0, skillComponent + courseComponent))
    );

    logger.debug('[CareerMatching] Learning progress computed', {
      userId,
      skillsAdded,
      coursesStarted,
      learningProgress: result
    });

    // ── Cache Result (optional) ──
    /*
    await redis.set(cacheKey, JSON.stringify(result), 'EX', 300);
    */

    return result;
  } catch (err) {
    logger.warn('[CareerMatching] computeLearningProgress failed', {
      userId,
      error: err.message
    });
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────
// Role Scoring
// ─────────────────────────────────────────────────────────────

function calculateRoleScore(profile, role, learningProgress = 0) {
  const profileSkills = new Set(
    (profile.skills ?? []).map(s => s.toLowerCase().trim())
  );

  const requiredSkills = (role.requiredSkills || role.required_skills || [])
    .map(s => s.toLowerCase().trim());

  // ── Skill Match ──
  let skillMatch = 0;
  if (requiredSkills.length > 0) {
    const matched = requiredSkills.filter(s => profileSkills.has(s)).length;
    skillMatch = Math.round((matched / requiredSkills.length) * 100);
  }

  // ── Experience Fit ──
  const years = profile.experienceYears ?? 0;
  const expMin = role.experienceMin ?? role.experience_min ?? 0;
  const expMax = role.experienceMax ?? role.experience_max ?? 20;

  let experienceFit = 0;
  if (years >= expMin && years <= expMax) {
    experienceFit = 100;
  } else if (years < expMin) {
    experienceFit = Math.max(0, 100 - (expMin - years) * 20);
  } else {
    experienceFit = Math.max(0, 100 - (years - expMax) * 10);
  }

  // ── Market Demand ──
  const rawDemand = role.marketDemand ?? role.market_demand ?? 5;
  const marketDemand = Math.min(100, Math.round((rawDemand / 10) * 100));

  // ── Learning Progress ──
  const safeLearning = Math.min(100, Math.max(0, learningProgress));

  // ── CHI Score ──
  const chiScore = Math.round(
    skillMatch * 0.40 +
    experienceFit * 0.30 +
    marketDemand * 0.20 +
    safeLearning * 0.10
  );

  return {
    skillMatch,
    experienceFit,
    marketDemand,
    learningProgress: safeLearning,
    chiScore,
    insights: {
      missingSkills: requiredSkills.filter(s => !profileSkills.has(s)),
      experienceGap: years < expMin ? expMin - years : 0
    }
  };
}

// ─────────────────────────────────────────────────────────────
// Role Matching
// ─────────────────────────────────────────────────────────────

async function matchCareerRoles(profile, domainId, { limit = 10 } = {}) {
  try {
    const learningProgress = profile.userId
      ? await computeLearningProgress(profile.userId)
      : 0;

    let query = supabase
      .from('cms_roles')
      .select(`
        id,
        required_skills,
        experience_min,
        experience_max,
        market_demand
      `)
      .eq('softDeleted', false)
      .eq('status', 'active');

    if (domainId) {
      query = query.eq('domainId', domainId);
    }

    const { data, error } = await query;
    if (error) throw error;

    const roles = data ?? [];

    const scored = roles.map(role => ({
      role,
      scores: calculateRoleScore(profile, role, learningProgress)
    }));

    // Sort by CHI score
    scored.sort((a, b) => b.scores.chiScore - a.scores.chiScore);

    return scored.slice(0, limit).map((item, idx) => ({
      ...item,
      rank: idx + 1
    }));

  } catch (err) {
    logger.error('[CareerMatchingService] matchCareerRoles failed', {
      error: err.message
    });
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// CHI Score Persistence
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
      last_updated: new Date().toISOString()
    };

    const { error } = await supabase
      .from('chi_scores')
      .upsert([payload]);

    if (error) throw error;

    return { id: payload.id };
  } catch (err) {
    logger.error('[CareerMatchingService] saveChiScore failed', {
      error: err.message
    });
    throw err;
  }
}

async function getChiScore(userId, roleId) {
  try {
    const { data, error } = await supabase
      .from('chi_scores')
      .select('*')
      .eq('id', `${userId}_${roleId}`)
      .maybeSingle();

    if (error) throw error;
    return data ?? null;
  } catch (err) {
    logger.error('[CareerMatchingService] getChiScore failed', {
      error: err.message
    });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Graph-Based CHI (Advanced)
// ─────────────────────────────────────────────────────────────

function computeGraphCHIForRole(profile) {
  if (!profile?.targetRoleId && !profile?.targetRoleName) return null;

  let p = { ...profile };

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
  computeGraphCHIForRole
};