'use strict';

/**
 * routes/skills.routes.js
 *
 * Enterprise-hardened skill routes
 * Fully Supabase-aligned
 */

const express = require('express');
const { body, param, query } = require('express-validator');

const { validate } = require('../middleware/requestValidator');
const { requireAdmin } = require('../middleware/auth.middleware');
const { asyncHandler } = require('../utils/helpers');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const logger = require('../utils/logger');
const supabase = require('../lib/supabaseClient');

const skillsController = require('../controllers/skills.controller');
const {
  getSkillRecommendations,
  addSkillsToProfile,
} = require('../modules/skillDemand/skillRecommendations.service');

const router = express.Router();

const VALID_CATEGORIES = Object.freeze([
  'technical',
  'soft',
  'domain',
  'tool',
  'language',
  'framework',
]);

const VALID_PROFICIENCY = Object.freeze([
  'beginner',
  'intermediate',
  'advanced',
  'expert',
]);

const MAX_SKILLS = 50;
const MAX_SKILL_LENGTH = 100;

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function getUserId(req) {
  const userId =
    req.user?.id ||
    req.auth?.userId ||
    req.user?.user_id ||
    req.user?.uid; // legacy fallback

  if (!userId || typeof userId !== 'string') {
    throw new AppError(
      'Unauthorized',
      401,
      {},
      ErrorCodes.UNAUTHORIZED,
    );
  }

  return userId;
}

function normalizeSkillNames(skills = []) {
  const seen = new Set();
  const normalized = [];

  for (const raw of skills) {
    if (typeof raw !== 'string') continue;

    const skill = raw.trim();
    if (!skill) continue;

    if (skill.length > MAX_SKILL_LENGTH) continue;

    const key = skill.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    normalized.push(skill);
  }

  return normalized;
}

/**
 * Remove skills through Supabase RPC.
 *
 * RPC must return:
 * {
 *   removed_count: number,
 *   updated_skills: jsonb
 * }
 */
async function removeSkillsFromProfile(userId, skills) {
  const { data, error } = await supabase.rpc('remove_user_skills', {
    p_user_id: userId,
    p_skill_names: skills,
  });

  if (error) {
    logger.error('[Skills] remove_user_skills RPC failed', {
      userId,
      code: error.code,
      message: error.message,
      hint: error.hint,
    });

    throw new AppError(
      error.message || 'Failed to remove skills',
      500,
      {
        supabaseCode: error.code,
        hint: error.hint,
      },
      ErrorCodes.INTERNAL_ERROR,
    );
  }

  /**
   * IMPORTANT:
   * Supabase jsonb RPCs may return:
   * - null
   * - plain object
   * - single-element array
   * depending on client config/version
   */
  const payload = Array.isArray(data) ? data[0] : data;

  if (!payload || typeof payload !== 'object') {
    logger.warn('[Skills] remove_user_skills returned empty payload', {
      userId,
      requestedCount: skills.length,
    });

    return {
      removedCount: 0,
      updatedSkills: [],
    };
  }

  return {
    removedCount: Number(payload.removed_count) || 0,
    updatedSkills: Array.isArray(payload.updated_skills)
      ? payload.updated_skills
      : [],
  };
}

// ─────────────────────────────────────────────────────────────
// GET /
// ─────────────────────────────────────────────────────────────
router.get(
  '/',
  validate([
    query('limit')
      .optional()
      .isInt({ min: 1, max: 500 }),
    query('category')
      .optional()
      .isIn(VALID_CATEGORIES),
  ]),
  skillsController.listSkills,
);

// ─────────────────────────────────────────────────────────────
// POST /
// ─────────────────────────────────────────────────────────────
router.post(
  '/',
  requireAdmin,
  validate([
    body('name')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ min: 1, max: 150 }),
    body('category')
      .optional()
      .isIn(VALID_CATEGORIES),
    body('aliases')
      .optional()
      .isArray({ max: 20 }),
    body('aliases.*')
      .optional()
      .isString()
      .trim()
      .isLength({ max: MAX_SKILL_LENGTH }),
    body('description')
      .optional()
      .isString()
      .trim()
      .isLength({ max: 500 }),
    body('demandScore')
      .optional()
      .isInt({ min: 0, max: 100 }),
  ]),
  skillsController.createSkill,
);

// ─────────────────────────────────────────────────────────────
// POST /gap-analysis
// ─────────────────────────────────────────────────────────────
router.post(
  '/gap-analysis',
  validate([
    body('targetRoleId')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: 100 }),
    body('userSkills')
      .isArray({ min: 0, max: 200 }),
    body('userSkills.*.name')
      .isString()
      .trim()
      .notEmpty(),
    body('userSkills.*.proficiencyLevel')
      .optional()
      .isIn(VALID_PROFICIENCY),
    body('userSkills.*.yearsOfExperience')
      .optional()
      .isFloat({ min: 0, max: 50 })
      .toFloat(),
    body('includeRecommendations')
      .optional()
      .isBoolean()
      .toBoolean(),
  ]),
  skillsController.analyzeGap,
);

// ─────────────────────────────────────────────────────────────
// POST /bulk-gap
// ─────────────────────────────────────────────────────────────
router.post(
  '/bulk-gap',
  validate([
    body('targetRoleIds')
      .isArray({ min: 1, max: 10 }),
    body('targetRoleIds.*')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: 100 }),
    body('userSkills')
      .isArray({ min: 0, max: 200 }),
    body('userSkills.*.name')
      .isString()
      .trim()
      .notEmpty(),
  ]),
  skillsController.bulkGapAnalysis,
);

// ─────────────────────────────────────────────────────────────
// GET /search
// ─────────────────────────────────────────────────────────────
router.get(
  '/search',
  validate([
    query('q')
      .isString()
      .trim()
      .isLength({ min: 2, max: 50 }),
    query('category')
      .optional()
      .isIn(VALID_CATEGORIES),
  ]),
  skillsController.searchSkills,
);

// ─────────────────────────────────────────────────────────────
// GET /role/:roleId
// ─────────────────────────────────────────────────────────────
router.get(
  '/role/:roleId',
  validate([
    param('roleId')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: 100 }),
  ]),
  skillsController.getRoleSkills,
);

// ─────────────────────────────────────────────────────────────
// GET /recommendations
// ─────────────────────────────────────────────────────────────
router.get(
  '/recommendations',
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);

    logger.info('[Skills] Fetching recommendations', { userId });

    const data = await getSkillRecommendations(userId);

    return res.status(200).json({
      success: true,
      data,
    });
  }),
);

// ─────────────────────────────────────────────────────────────
// POST /add
// ─────────────────────────────────────────────────────────────
router.post(
  '/add',
  validate([
    body('skills')
      .isArray({ min: 1, max: MAX_SKILLS }),
    body('skills.*')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: MAX_SKILL_LENGTH }),
  ]),
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const skills = normalizeSkillNames(req.body.skills);

    if (skills.length === 0) {
      throw new AppError(
        'No valid skill names provided',
        400,
        {},
        ErrorCodes.VALIDATION_ERROR,
      );
    }

    logger.info('[Skills] Adding skills', {
      userId,
      requested: req.body.skills.length,
      normalized: skills.length,
    });

    const result = await addSkillsToProfile(userId, skills);

    return res.status(200).json({
      success: true,
      data: result,
    });
  }),
);

// ─────────────────────────────────────────────────────────────
// POST /remove
// ─────────────────────────────────────────────────────────────
router.post(
  '/remove',
  validate([
    body('skills')
      .isArray({ min: 1, max: MAX_SKILLS }),
    body('skills.*')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: MAX_SKILL_LENGTH }),
  ]),
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const skills = normalizeSkillNames(req.body.skills);

    if (skills.length === 0) {
      throw new AppError(
        'No valid skill names provided',
        400,
        {},
        ErrorCodes.VALIDATION_ERROR,
      );
    }

    logger.info('[Skills] Removing skills via RPC', {
      userId,
      requested: req.body.skills.length,
      normalized: skills.length,
    });

    const result = await removeSkillsFromProfile(userId, skills);

    logger.info('[Skills] Skills removed', {
      userId,
      requested: skills.length,
      removed: result.removedCount,
    });

    return res.status(200).json({
      success: true,
      data: result,
    });
  }),
);

// ─────────────────────────────────────────────────────────────
// GET /:id
// ─────────────────────────────────────────────────────────────
router.get(
  '/:id',
  validate([
    param('id')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: 128 }),
  ]),
  skillsController.getSkillById,
);

// ─────────────────────────────────────────────────────────────
// PUT /:id
// ─────────────────────────────────────────────────────────────
router.put(
  '/:id',
  requireAdmin,
  validate([
    param('id')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: 128 }),
    body('name')
      .optional()
      .isString()
      .trim()
      .isLength({ min: 1, max: 150 }),
    body('category')
      .optional()
      .isIn(VALID_CATEGORIES),
    body('aliases')
      .optional()
      .isArray({ max: 20 }),
    body('description')
      .optional()
      .isString()
      .trim()
      .isLength({ max: 500 }),
    body('demandScore')
      .optional()
      .isInt({ min: 0, max: 100 }),
  ]),
  skillsController.updateSkill,
);

// ─────────────────────────────────────────────────────────────
// DELETE /:id
// ─────────────────────────────────────────────────────────────
router.delete(
  '/:id',
  requireAdmin,
  validate([
    param('id')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: 128 }),
  ]),
  skillsController.deleteSkill,
);

module.exports = router;