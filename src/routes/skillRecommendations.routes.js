'use strict';

/**
 * routes/skillRecommendations.routes.js
 *
 * Mounted in server.js:
 *   app.use(
 *     `${API_PREFIX}/skills`,
 *     authenticate,
 *     require('./routes/skillRecommendations.routes')
 *   );
 *
 * Endpoints:
 *   GET  /recommendations
 *   POST /add
 */

const express = require('express');
const { body } = require('express-validator');

const { validate } = require('../middleware/requestValidator');
const { asyncHandler } = require('../utils/helpers');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const {
  getSkillRecommendations,
  addSkillsToProfile,
} = require('../modules/skillDemand/skillRecommendations.service');
const logger = require('../utils/logger');

const router = express.Router();

const MAX_SKILLS_PER_REQUEST = 50;
const MAX_SKILL_LENGTH = 100;

/**
 * Extract authenticated user ID in a provider-agnostic way.
 *
 * Supports:
 * - Supabase JWT middleware → req.user.id
 * - normalized auth middleware → req.auth.userId
 * - legacy compatibility → req.user.uid
 *
 * This safely removes Firebase-specific assumptions while
 * preserving backward compatibility during rollout.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
function getAuthenticatedUserId(req) {
  const userId =
    req.user?.id ||
    req.auth?.userId ||
    req.user?.user_id ||
    req.user?.uid; // legacy fallback during migration

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

/**
 * Normalize incoming skills:
 * - trim whitespace
 * - remove empty values
 * - deduplicate case-insensitively
 * - preserve original casing of first occurrence
 *
 * @param {string[]} skills
 * @returns {string[]}
 */
function normalizeSkills(skills) {
  if (!Array.isArray(skills)) return [];

  const seen = new Set();
  const normalized = [];

  for (const rawSkill of skills) {
    if (typeof rawSkill !== 'string') continue;

    const skill = rawSkill.trim();
    if (!skill) continue;

    const key = skill.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    normalized.push(skill);
  }

  return normalized;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/skills/recommendations
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/recommendations',
  asyncHandler(async (req, res) => {
    const userId = getAuthenticatedUserId(req);

    logger.info('[SkillRecommendations] Fetching recommendations', {
      userId,
      route: 'GET /recommendations',
    });

    const data = await getSkillRecommendations(userId);

    return res.status(200).json({
      success: true,
      data,
    });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/skills/add
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/add',
  validate([
    body('skills')
      .isArray({ min: 1, max: MAX_SKILLS_PER_REQUEST })
      .withMessage(
        `skills must be a non-empty array (max ${MAX_SKILLS_PER_REQUEST})`,
      ),
    body('skills.*')
      .isString()
      .withMessage('Each skill must be a string')
      .trim()
      .notEmpty()
      .withMessage('Each skill must be a non-empty string')
      .isLength({ max: MAX_SKILL_LENGTH })
      .withMessage(
        `Each skill name must be under ${MAX_SKILL_LENGTH} characters`,
      ),
  ]),
  asyncHandler(async (req, res) => {
    const userId = getAuthenticatedUserId(req);
    const normalizedSkills = normalizeSkills(req.body.skills);

    logger.info('[SkillRecommendations] Adding skills to profile', {
      userId,
      route: 'POST /add',
      requestedCount: req.body.skills.length,
      normalizedCount: normalizedSkills.length,
    });

    const result = await addSkillsToProfile(userId, normalizedSkills);

    return res.status(200).json({
      success: true,
      data: result,
    });
  }),
);

module.exports = router;