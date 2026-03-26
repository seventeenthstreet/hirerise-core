'use strict';

/**
 * careerMatching.service.js — UPGRADED
 *
 * Changes from previous version:
 *   LEARNING PROGRESS: Was permanently hardcoded to 0.
 *   Now computed from real user activity events in Firestore:
 *     learningProgress = (skillsAddedThisMonth / 5) * 50
 *                      + (coursesStarted / 3) * 50
 *   Capped at 100. Falls back to 0 gracefully on any error.
 *
 * All other logic (skill match, experience fit, market demand,
 * matchCareerRoles, saveChiScore, getChiScore, computeGraphCHIForRole)
 * is unchanged.
 */

const logger = require('../utils/logger');
const careerGraph = require('../modules/careerGraph/CareerGraph');

const getDb = () => require('../config/supabase').db;

// ─── Learning Progress ────────────────────────────────────────────────────────

/**
 * computeLearningProgress(userId)
 *
 * Reads the last 30 days of activity events from:
 *   users/{userId}/activityEvents
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
    const db = getDb();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // Read last 30 days of activity events
    // userActivity.service.js writes to users/{userId}/activityEvents
    const snap = await db
      .collection('users')
      .doc(userId)
      .collection('activityEvents')
      .where('createdAt', '>=', thirtyDaysAgo)
      .orderBy('createdAt', 'desc')
      .limit(200) // safety cap
      .get();

    if (snap.empty) return 0;

    let skillsAdded   = 0;
    let coursesStarted = 0;

    snap.docs.forEach(doc => {
      const { eventType } = doc.data();
      // skill_added: user adds a skill to their profile
      // course_started: user clicks a learning recommendation
      if (eventType === 'skill_added')    skillsAdded++;
      if (eventType === 'course_started') coursesStarted++;
    });

    // Also check ava_memory for skills_added count (written by avaMemory.service.js)
    // This catches skills added through the Ava memory system as well
    try {
      const avaSnap = await db
        .collection('ava_memory')
        .where('user_id', '==', userId)
        .limit(1)
        .get();

      if (!avaSnap.empty) {
        const avaData = avaSnap.docs[0].data();
        // avaMemory stores weekly count — use as supplementary signal
        const avaSkillsThisWeek = avaData.skills_added ?? 0;
        // Weight weekly data lower: approximate monthly = weekly * 2
        skillsAdded = Math.max(skillsAdded, Math.round(avaSkillsThisWeek * 2));
      }
    } catch (_) {
      // ava_memory read is purely supplementary — non-fatal
    }

    const skillComponent  = Math.min(1, skillsAdded   / 5) * 50;
    const courseComponent = Math.min(1, coursesStarted / 3) * 50;
    const raw             = skillComponent + courseComponent;

    const result = Math.round(Math.min(100, Math.max(0, raw)));

    logger.debug('[CareerMatching] Learning progress computed', {
      userId, skillsAdded, coursesStarted, learningProgress: result,
    });

    return result;

  } catch (err) {
    // Non-fatal: fall back to 0 so matching still works
    logger.warn('[CareerMatching] computeLearningProgress failed (using 0)', {
      userId, error: err.message,
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
    const profileSkillSet = new Set(
      (profile.skills ?? []).map(s => s.toLowerCase().trim())
    );
    const matched = requiredSkills.filter(s =>
      profileSkillSet.has(s.toLowerCase().trim())
    ).length;
    skillMatch = Math.round((matched / requiredSkills.length) * 100);
  }

  // ── Experience Fit (0-100) ────────────────────────────────────────────
  const years  = profile.experienceYears ?? 0;
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
  const rawDemand   = role.marketDemand ?? role.market_demand ?? 5;
  const marketDemand = Math.min(100, Math.round((rawDemand / 10) * 100));

  // ── Learning Progress (0-100) — REAL DATA NOW ─────────────────────────
  const safeLearning = Math.min(100, Math.max(0, learningProgress));

  // ── Composite CHI Score ───────────────────────────────────────────────
  const chiScore = Math.round(
    skillMatch     * 0.40 +
    experienceFit  * 0.30 +
    marketDemand   * 0.20 +
    safeLearning   * 0.10
  );

  return { skillMatch, experienceFit, marketDemand, learningProgress: safeLearning, chiScore };
}

// ── Role Matching ─────────────────────────────────────────────────────────────

/**
 * matchCareerRoles(profile, domainId, options)
 *
 * Now fetches real learning progress before scoring.
 * If profile.userId is provided, learning progress is computed from DB.
 */
async function matchCareerRoles(profile, domainId, { limit = 10 } = {}) {
  try {
    // Fetch learning progress once for this user — reused across all role scores
    const learningProgress = profile.userId
      ? await computeLearningProgress(profile.userId)
      : 0;

    let query = getDb()
      .collection('cms_roles')
      .where('softDeleted', '==', false)
      .where('status', '==', 'active');

    if (domainId) {
      query = query.where('domainId', '==', domainId);
    }

    const snap  = await query.get();
    const roles = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    const scored = roles.map(role => ({
      role,
      scores: calculateRoleScore(profile, role, learningProgress),
    }));

    scored.sort((a, b) => b.scores.chiScore - a.scores.chiScore);

    return scored.slice(0, limit).map((item, idx) => ({
      ...item,
      rank: idx + 1,
    }));
  } catch (err) {
    logger.error('[CareerMatchingService] matchCareerRoles failed', { error: err.message });
    return [];
  }
}

// ── CHI Score Persistence ─────────────────────────────────────────────────────

async function saveChiScore(userId, roleId, breakdown) {
  try {
    const db   = getDb();
    const docId = `${userId}_${roleId}`;
    const ref   = db.collection('chi_scores').doc(docId);

    const payload = {
      user_id:           userId,
      role_id:           roleId,
      skill_match:       breakdown.skillMatch,
      experience_fit:    breakdown.experienceFit,
      market_demand:     breakdown.marketDemand,
      learning_progress: breakdown.learningProgress,
      chi_score:         breakdown.chiScore,
      last_updated:      new Date().toISOString(),
    };

    await ref.set(payload, { merge: true });

    logger.info('[CareerMatchingService] CHI score saved', {
      userId, roleId, chiScore: breakdown.chiScore,
      learningProgress: breakdown.learningProgress,
    });
    return { id: docId };
  } catch (err) {
    logger.error('[CareerMatchingService] saveChiScore failed', { error: err.message });
    throw err;
  }
}

async function getChiScore(userId, roleId) {
  try {
    const docId = `${userId}_${roleId}`;
    const doc   = await getDb().collection('chi_scores').doc(docId).get();
    if (!doc.exists) return null;
    return { id: doc.id, ...doc.data() };
  } catch (err) {
    logger.error('[CareerMatchingService] getChiScore failed', { error: err.message });
    return null;
  }
}

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
  calculateRoleScore,
  matchCareerRoles,
  saveChiScore,
  getChiScore,
  computeGraphCHIForRole,
  computeLearningProgress, // exported for testing
};








