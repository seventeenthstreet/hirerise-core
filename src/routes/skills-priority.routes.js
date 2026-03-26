'use strict';

/**
 * skills-priority.routes.js — Skill Prioritization Intelligence API
 *
 * Mounted in server.js alongside the existing skillDemandRouter:
 *   app.use(`${API_PREFIX}/skills`, authenticate, require('./routes/skills-priority.routes'));
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ Method │ Path          │ Description                                     │
 * ├──────────────────────────────────────────────────────────────────────────┤
 * │ GET    │ /priority     │ Run prioritization engine for the auth user     │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * The handler reads the user's profile + CHI snapshot from Firestore to
 * build the engine input — the caller does not need to POST a body.
 * All heavy lifting is cached: the route caches results per user for 30 min.
 *
 * Response shape:
 *   {
 *     success: true,
 *     data: {
 *       meta:              { engineVersion, generatedAt, isPremiumView, skillsReturned, totalEvaluated },
 *       summary:           { totalSkillsAnalyzed, highPriorityCount, avgPriorityScore, estimatedSalaryDelta },
 *       prioritizedSkills: [ { skillId, skillName, priorityScore, priorityLevel, roiCategory,
 *                              estimatedLearningTimeWeeks, marketDemandScore, salaryImpactScore, ... } ],
 *       careerPathInsight: { nextRoleUnlocked, unlockProbabilityIncrease, ... },
 *       confidenceInsight: { confidenceScore, confidenceLevel, factors },
 *       narrative:         string,
 *     }
 *   }
 */

const express             = require('express');
const { query }           = require('express-validator');
const { validate }        = require('../middleware/requestValidator');
const { asyncHandler }    = require('../utils/helpers');
const { db }              = require('../config/supabase');
const cacheManager        = require('../core/cache/cache.manager');
const logger              = require('../utils/logger');
const engine              = require('../modules/skill-prioritization');

const router = express.Router();
const cache  = cacheManager.getClient();

const CACHE_TTL_SECONDS = 1800; // 30 min

// ─── GET /priority ────────────────────────────────────────────────────────────

router.get(
  '/priority',
  validate([
    query('refresh')
      .optional()
      .isBoolean()
      .withMessage('refresh must be a boolean'),
  ]),
  asyncHandler(async (req, res) => {
    const userId = req.user?.uid || req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthenticated' });
    }

    const forceRefresh = req.query.refresh === 'true';
    const cacheKey     = `skill-priority:user:${userId}`;

    // ── 1. Cache check ──────────────────────────────────────────────────────
    if (!forceRefresh) {
      try {
        const hit = await cache.get(cacheKey);
        if (hit) {
          logger.info('[SkillPriorityRoute] Cache hit', { userId });
          return res.status(200).json({
            success: true,
            data:    JSON.parse(hit),
            cached:  true,
          });
        }
      } catch (_) { /* cache miss is fine */ }
    }

    // ── 2. Load user profile from Firestore ─────────────────────────────────
    const [profileSnap, progressSnap, userSnap] = await Promise.all([
      db.collection('userProfiles').doc(userId).get().catch(() => null),
      db.collection('onboardingProgress').doc(userId).get().catch(() => null),
      db.collection('users').doc(userId).get().catch(() => null),
    ]);

    const profile  = profileSnap?.exists  ? profileSnap.data()  : {};
    const progress = progressSnap?.exists ? progressSnap.data() : {};
    const user     = userSnap?.exists     ? userSnap.data()     : {};

    // FIX: Use per-user subcollection (no composite index needed) instead of
    // flat careerHealthIndex which required a missing Firestore composite index.
    let chiData = {};
    try {
      const chiSnap = await db.collection('users').doc(userId)
        .collection('chiSnapshots')
        .where('softDeleted', '==', false)
        .orderBy('generatedAt', 'desc')
        .limit(1)
        .get();
      if (!chiSnap.empty) chiData = chiSnap.docs[0].data();
    } catch (_) {
      // Fallback to legacy flat collection
      try {
        const chiSnap = await db.collection('careerHealthIndex')
          .where('userId', '==', userId)
          .orderBy('generatedAt', 'desc')
          .limit(1)
          .get();
        if (!chiSnap && !chiSnap.empty) chiData = chiSnap.docs[0].data();
      } catch (_) {}
    }

    // Resolve skills — prefer CHI topSkills (CV-extracted) over profile.skills
    // Check all 3 collections for skills — same pattern as jobMatchingEngine
    const rawProfileSkills =
      (Array.isArray(profile.skills)   && profile.skills.length   > 0) ? profile.skills   :
      (Array.isArray(user.skills)      && user.skills.length      > 0) ? user.skills      :
      (Array.isArray(progress.skills)  && progress.skills.length  > 0) ? progress.skills  :
      [];

    // Also pick up targetRole and experienceYears from users collection
    if (!profile.targetRole && !profile.currentJobTitle) {
      profile.targetRole = user.currentJobTitle || progress.targetRole || null;
    }
    if (!profile.experienceYears && !profile.yearsExperience) {
      profile.experienceYears = user.experience || user.experienceYears || progress.experienceYears || 0;
    }

    const chiTopSkills  = Array.isArray(chiData.topSkills) ? chiData.topSkills : [];

    // Merge: CHI top skills (strings) + profile skills (may have proficiency)
    const profileSkillMap = {};
    for (const s of rawProfileSkills) {
      const name = typeof s === 'string' ? s : (s.name || '');
      const prof = typeof s === 'object' ? (s.proficiency || s.proficiencyLevel || 50) : 50;
      if (name) profileSkillMap[name.toLowerCase()] = { name, proficiency: prof };
    }

    const mergedSkills = chiTopSkills.map(name => {
      const key     = name.toLowerCase();
      const fromMap = profileSkillMap[key];
      return {
        skillId:          name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, ''),
        skillName:        name,
        proficiencyLevel: fromMap ? fromMap.proficiency : 50,
      };
    });

    // Add any profile skills not in CHI top skills
    for (const [, s] of Object.entries(profileSkillMap)) {
      const id = s.name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
      if (!mergedSkills.find(m => m.skillId === id)) {
        mergedSkills.push({ skillId: id, skillName: s.name, proficiencyLevel: s.proficiency });
      }
    }

    // ── 3. Guard: need at least one skill and a target role ──────────────────
    const targetRole =
      profile.targetRole || profile.currentJobTitle ||
      chiData.detectedProfession || chiData.currentJobTitle || null;

    if (!targetRole) {
      return res.status(200).json({
        success: true,
        data:    null,
        message: 'Set your target role in your profile to activate Skill Prioritization.',
      });
    }

    if (mergedSkills.length === 0) {
      return res.status(200).json({
        success: true,
        data:    null,
        message: 'Upload your CV to activate Skill Prioritization. Skills will be extracted automatically.',
      });
    }

    // ── 4. Build engine input ───────────────────────────────────────────────
    const input = {
      userId,
      targetRoleId:   targetRole,
      currentRoleId:  profile.currentRole || profile.currentJobTitle || targetRole,
      experienceYears: Number(profile.experienceYears || profile.yearsExperience || chiData.estimatedExperienceYears || 0),
      // resumeScore: use CHI skillVelocity dimension score as proxy if direct score unavailable
      resumeScore: Number(
        profile.resumeScore ||
        chiData.dimensions?.skillVelocity?.score ||
        chiData.chiScore ||
        50
      ),
      skills: mergedSkills,
    };

    logger.info('[SkillPriorityRoute] Running engine', {
      userId,
      targetRole,
      skillCount: mergedSkills.length,
    });

    // ── 5. Run engine ────────────────────────────────────────────────────────
    const isPremium = profile.plan === 'premium' || profile.isPremium || false;
    const result    = await engine.run(input, { isPremium });

    // ── 6. Cache result ──────────────────────────────────────────────────────
    try {
      await cache.set(cacheKey, JSON.stringify(result), CACHE_TTL_SECONDS);
    } catch (_) { /* non-fatal */ }

    logger.info('[SkillPriorityRoute] Done', {
      userId,
      skills:      result.meta?.skillsReturned,
      highPriority: result.summary?.highPriorityCount,
    });

    return res.status(200).json({
      success: true,
      data:    result,
      cached:  false,
    });
  })
);

module.exports = router;








