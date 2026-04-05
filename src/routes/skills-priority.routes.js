'use strict';

/**
 * routes/skills-priority.routes.js
 *
 * Skill Prioritization Intelligence API
 * Fully optimized for Supabase production workloads
 */

const express = require('express');
const { query } = require('express-validator');

const { validate } = require('../middleware/requestValidator');
const { asyncHandler } = require('../utils/helpers');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const supabase = require('../lib/supabaseClient');
const cacheManager = require('../core/cache/cache.manager');
const logger = require('../utils/logger');
const engine = require('../modules/skill-prioritization');

const router = express.Router();

const cache = cacheManager.getClient();
const CACHE_TTL_SECONDS = 1800;
const DEFAULT_PROFICIENCY = 50;

/**
 * Auth-provider agnostic user ID extraction
 */
function getUserId(req) {
  const userId =
    req.user?.id ||
    req.auth?.userId ||
    req.user?.user_id ||
    req.user?.uid;

  if (!userId || typeof userId !== 'string') {
    throw new AppError(
      'Unauthenticated',
      401,
      {},
      ErrorCodes.UNAUTHORIZED,
    );
  }

  return userId;
}

function createSkillId(name) {
  return String(name)
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

function buildMergedSkills(profileSkills, chiTopSkills) {
  const profileSkillMap = new Map();

  for (const raw of profileSkills) {
    const name =
      typeof raw === 'string'
        ? raw
        : raw?.name || raw?.skillName || '';

    if (!name) continue;

    const proficiency =
      typeof raw === 'object'
        ? raw.proficiency ||
          raw.proficiencyLevel ||
          DEFAULT_PROFICIENCY
        : DEFAULT_PROFICIENCY;

    profileSkillMap.set(name.toLowerCase(), {
      name,
      proficiency,
    });
  }

  const merged = [];
  const seen = new Set();

  for (const name of chiTopSkills) {
    if (!name) continue;

    const key = name.toLowerCase();
    const fromProfile = profileSkillMap.get(key);

    merged.push({
      skillId: createSkillId(name),
      skillName: name,
      proficiencyLevel: fromProfile?.proficiency || DEFAULT_PROFICIENCY,
    });

    seen.add(key);
  }

  for (const [key, skill] of profileSkillMap.entries()) {
    if (seen.has(key)) continue;

    merged.push({
      skillId: createSkillId(skill.name),
      skillName: skill.name,
      proficiencyLevel: skill.proficiency,
    });
  }

  return merged;
}

// ─────────────────────────────────────────────────────────────
// GET /priority
// ─────────────────────────────────────────────────────────────
router.get(
  '/priority',
  validate([
    query('refresh')
      .optional()
      .isBoolean()
      .withMessage('refresh must be a boolean'),
  ]),
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const forceRefresh = req.query.refresh === 'true';
    const cacheKey = `skill-priority:user:${userId}`;

    // 1) Cache
    if (!forceRefresh) {
      try {
        const hit = await cache.get(cacheKey);

        if (hit) {
          logger.info('[SkillPriorityRoute] Cache hit', { userId });

          return res.status(200).json({
            success: true,
            data: JSON.parse(hit),
            cached: true,
          });
        }
      } catch (error) {
        logger.warn('[SkillPriorityRoute] Cache read failed', {
          userId,
          message: error.message,
        });
      }
    }

    // 2) Load only required columns (major Supabase perf win)
    const [profileResult, progressResult, userResult, chiResult] =
      await Promise.all([
        supabase
          .from('user_profiles')
          .select(
            'skills,target_role,current_job_title,current_role,experience_years,years_experience,resume_score,plan,is_premium',
          )
          .eq('user_id', userId)
          .maybeSingle(),

        supabase
          .from('onboarding_progress')
          .select('skills,target_role,experience_years')
          .eq('user_id', userId)
          .maybeSingle(),

        supabase
          .from('users')
          .select(
            'skills,current_job_title,experience,experience_years',
          )
          .eq('id', userId)
          .maybeSingle(),

        supabase
          .from('chi_snapshots')
          .select(
            'data,generated_at',
          )
          .eq('user_id', userId)
          .eq('soft_deleted', false)
          .order('generated_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

    const profile = profileResult.data || {};
    const progress = progressResult.data || {};
    const user = userResult.data || {};
    const chiData = chiResult.data?.data || {};

    const rawProfileSkills =
      Array.isArray(profile.skills) && profile.skills.length
        ? profile.skills
        : Array.isArray(user.skills) && user.skills.length
          ? user.skills
          : Array.isArray(progress.skills)
            ? progress.skills
            : [];

    const chiTopSkills = Array.isArray(chiData.topSkills)
      ? chiData.topSkills
      : [];

    const mergedSkills = buildMergedSkills(
      rawProfileSkills,
      chiTopSkills,
    );

    const targetRole =
      profile.target_role ||
      profile.current_job_title ||
      progress.target_role ||
      chiData.detectedProfession ||
      chiData.currentJobTitle ||
      null;

    if (!targetRole) {
      return res.status(200).json({
        success: true,
        data: null,
        message:
          'Set your target role in your profile to activate Skill Prioritization.',
      });
    }

    if (mergedSkills.length === 0) {
      return res.status(200).json({
        success: true,
        data: null,
        message:
          'Upload your CV to activate Skill Prioritization. Skills will be extracted automatically.',
      });
    }

    const input = {
      userId,
      targetRoleId: targetRole,
      currentRoleId:
        profile.current_role ||
        profile.current_job_title ||
        targetRole,
      experienceYears: Number(
        profile.experience_years ||
          profile.years_experience ||
          chiData.estimatedExperienceYears ||
          0,
      ),
      resumeScore: Number(
        profile.resume_score ||
          chiData.dimensions?.skillVelocity?.score ||
          chiData.chiScore ||
          50,
      ),
      skills: mergedSkills,
    };

    const isPremium =
      profile.plan === 'premium' ||
      Boolean(profile.is_premium);

    logger.info('[SkillPriorityRoute] Running engine', {
      userId,
      targetRole,
      skillCount: mergedSkills.length,
    });

    const result = await engine.run(input, { isPremium });

    // 3) Cache write
    try {
      await cache.set(
        cacheKey,
        JSON.stringify(result),
        CACHE_TTL_SECONDS,
      );
    } catch (error) {
      logger.warn('[SkillPriorityRoute] Cache write failed', {
        userId,
        message: error.message,
      });
    }

    logger.info('[SkillPriorityRoute] Completed', {
      userId,
      skillsReturned: result.meta?.skillsReturned,
      highPriority: result.summary?.highPriorityCount,
    });

    return res.status(200).json({
      success: true,
      data: result,
      cached: false,
    });
  }),
);

module.exports = router;