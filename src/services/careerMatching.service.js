'use strict';

/**
 * careerMatching.service.js — UPGRADED
 *
 * Changes from previous version:
 *   LEARNING PROGRESS: Was permanently hardcoded to 0.
 *   Now computed from real user activity events in Supabase:
 *     learningProgress = (skillsAddedThisMonth / 5) * 50
 *                      + (coursesStarted / 3) * 50
 *   Capped at 100. Falls back to 0 gracefully on any error.
 *
 * All other logic (skill match, experience fit, market demand,
 * matchCareerRoles, saveChiScore, getChiScore, computeGraphCHIForRole)
 * is unchanged.
 *
 * Sub-collection users/{userId}/activityEvents has been migrated to the
 * flat table: activity_events (columns: user_id, event_type, metadata, created_at)
 */
const logger = require('../utils/logger');
const careerGraph = require('../modules/careerGraph/CareerGraph');
const supabase = require('../config/supabase');

// ─── Learning Progress ────────────────────────────────────────────────────────

/**
 * computeLearningProgress(userId)
 *
 * Reads the last 30 days of activity events from:
 *   activity_events table (migrated from users/{userId}/activityEvents sub-collection)
 *
 * Counts:
 *   - skill_added events    → skillsAddedThisMonth
 *   - course_started events → coursesStarted
 *
 * Formula (from spec):
 *   learningProgress = clamp((skillsAddedThisMonth / 5) * 50
 *                           + (coursesStarted / 3) * 50, 0, 100)
 *
 * @param {string} userId
 * @returns {Promise<number>} 0–100
 */
async function computeLearningProgress(userId) {
  if (!userId) return 0;
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // Read last 30 days of activity events
    // activity_events is the flat table replacing users/{userId}/activityEvents sub-collection
    const { data: activityRows, error: activityError } = await supabase
      .from('activity_events')
      .select('event_type')
      .eq('user_id', userId)
      .gte('created_at', thirtyDaysAgo)
      .order('created_at', { ascending: false })
      .limit(200); // safety cap

    if (activityError) throw activityError;

    if (!activityRows || activityRows.length === 0) return 0;

    let skillsAdded = 0;
    let coursesStarted = 0;

    activityRows.forEach(row => {
      const eventType = row.event_type;
      // skill_added: user adds a skill to their profile
      // course_started: user clicks a learning recommendation
      if (eventType === 'skill_added') skillsAdded++;
      if (eventType === 'course_started') coursesStarted++;
    });

    // Also check ava_memory for skills_added count (written by avaMemory.service.js)
    // This catches skills added through the Ava memory system as well
    try {
      const { data: avaRows, error: avaError } = await supabase
        .from('ava_memory')
        .select('skills_added')
        .eq('user_id', userId)
        .limit(1);

      if (!avaError && avaRows && avaRows.length > 0) {
        const avaData = avaRows[0];
        // avaMemory stores weekly count — use as supplementary signal
        const avaSkillsThisWeek = avaData.skills_added ?? 0;
        // Weight weekly data lower: approximate monthly = weekly * 2
        skillsAdded = Math.max(skillsAdded, Math.round(avaSkillsThisWeek * 2));
      }
    } catch (_) {
      // ava_memory read is purely supplementary — non-fatal
    }

    const skillComponent = Math.min(1, skillsAdded / 5) * 50;
    const courseComponent = Math.min(1, coursesStarted / 3) * 50;
    const raw = skillComponent + courseComponent;
    const result = Math.round(Math.min(100, Math.max(0, raw)));
    logger.debug('[CareerMatching] Learning progress computed', {
      userId,
      skillsAdded,
      coursesStarted,
      learningProgress: result
    });
    return result;
  } catch (err) {
    // Non-fatal: fall back to 0 so matching still works
    logger.warn('[CareerMatching] computeLearningProgress failed (using 0)', {
      userId,
      error: err.message
    });
    return 0;
  }
}

// ── Role Scoring ──────────────────────────────────────────────────────────────

/**
 * calculateRoleScore(profile, role, learningProgress?)
 *
 * Returns a composite 0-100 score based on:
 *   - skill_match        (40%) — fraction of required skills profile possesses
 *   - experience_fit     (30%) — how well years of experience maps to role band
 *   - market_demand      (20%) — role's market_demand field (0-10 → %)
 *   - learning_progress  (10%) — real activity-based progress (was always 0)
 */
function calculateRoleScore(profile, role, learningProgress = 0) {
  // ── Skill Match (0-100) ───────────────────────────────────────────────
  const requiredSkills = role.requiredSkills ?? role.required_skills ?? [];
  let skillMatch = 0;
  if (requiredSkills.length > 0) {
    const profileSkillSet = new Set((profile.skills ?? []).map(s => s.toLowerCase().trim()));
    const matched = requiredSkills.filter(s => profileSkillSet.has(s.toLowerCase().trim())).length;
    skillMatch = Math.round(matched / requiredSkills.length * 100);
  }

  // ── Experience Fit (0-100) ────────────────────────────────────────────
  const years = profile.experienceYears ?? 0;
  const expMin = role.experienceMin ?? role.experience_min ?? 0;
  const expMax = role.experienceMax ?? role.experience_max ?? 20;
  let experienceFit = 0;
  if (years >= expMin && years <= expMax) {
    experienceFit = 100;
  } else if (years < expMin) {
    const gap = expMin - years;
    experienceFit = Math.max(0, Math.round(100 - gap * 20));
  } else {
    const over = years - expMax;
    experienceFit = Math.max(0, Math.round(100 - over * 10));
  }

  // ── Market Demand (0-100) ─────────────────────────────────────────────
  const rawDemand = role.marketDemand ?? role.market_demand ?? 5;
  const marketDemand = Math.min(100, Math.round(rawDemand / 10 * 100));

  // ── Learning Progress (0-100) — REAL DATA NOW ─────────────────────────
  const safeLearning = Math.min(100, Math.max(0, learningProgress));

  // ── Composite CHI Score ───────────────────────────────────────────────
  const chiScore = Math.round(skillMatch * 0.40 + experienceFit * 0.30 + marketDemand * 0.20 + safeLearning * 0.10);
  return {
    skillMatch,
    experienceFit,
    marketDemand,
    learningProgress: safeLearning,
    chiScore
  };
}

// ── Role Matching ─────────────────────────────────────────────────────────────

/**
 * matchCareerRoles(profile, domainId, options)
 *
 * Now fetches real learning progress before scoring.
 * If profile.userId is provided, learning progress is computed from DB.
 */
async function matchCareerRoles(profile, domainId, {
  limit = 10
} = {}) {
  try {
    // Fetch learning progress once for this user — reused across all role scores
    const learningProgress = profile.userId ? await computeLearningProgress(profile.userId) : 0;

    let query = supabase
      .from('cms_roles')
      .select('*')
      .eq('softDeleted', false)
      .eq('status', 'active');

    if (domainId) {
      query = query.eq('domainId', domainId);
    }

    const { data: rolesData, error } = await query;
    if (error) throw error;

    const roles = (rolesData ?? []).map(row => ({
      id: row.id,
      ...row
    }));

    const scored = roles.map(role => ({
      role,
      scores: calculateRoleScore(profile, role, learningProgress)
    }));

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

// ── CHI Score Persistence ─────────────────────────────────────────────────────

async function saveChiScore(userId, roleId, breakdown) {
  try {
    const docId = `${userId}_${roleId}`;
    const payload = {
      id: docId,
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

    logger.info('[CareerMatchingService] CHI score saved', {
      userId,
      roleId,
      chiScore: breakdown.chiScore,
      learningProgress: breakdown.learningProgress
    });
    return {
      id: docId
    };
  } catch (err) {
    logger.error('[CareerMatchingService] saveChiScore failed', {
      error: err.message
    });
    throw err;
  }
}

async function getChiScore(userId, roleId) {
  try {
    const docId = `${userId}_${roleId}`;
    const { data, error } = await supabase
      .from('chi_scores')
      .select('*')
      .eq('id', docId)
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    return {
      id: data.id,
      ...data
    };
  } catch (err) {
    logger.error('[CareerMatchingService] getChiScore failed', {
      error: err.message
    });
    return null;
  }
}

function computeGraphCHIForRole(profile) {
  if (!profile?.targetRoleId && !profile?.targetRoleName) return null;
  let p = {
    ...profile
  };
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
  calculateRoleScore,
  matchCareerRoles,
  saveChiScore,
  getChiScore,
  computeGraphCHIForRole,
  computeLearningProgress // exported for testing
};