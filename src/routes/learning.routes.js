'use strict';

/**
 * routes/learning.routes.js
 * Learning Recommendation API Routes
 */

const express = require('express');
const { body } = require('express-validator');

const { validate } = require('../middleware/requestValidator');
const { asyncHandler } = require('../utils/helpers');
const { recommendLearning } = require('../engines/learning.engine');
const logger = require('../utils/logger');

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────
const MAX_SKILL_GAPS = 50;
const MAX_SKILLS = 100;
const MAX_SKILL_NAME = 150;
const MAX_ROLE_LENGTH = 200;
const MAX_EXPERIENCE = 60;

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function resolveUserId(req) {
  return (
    req?.user?.id ||
    req?.user?.uid ||
    req?.auth?.userId ||
    req?.user?.user_id ||
    null
  );
}

// ─────────────────────────────────────────────────────────────
// Shared validators
// ─────────────────────────────────────────────────────────────
const skillGapsValidator = [
  body('skill_gaps')
    .isArray({ min: 1, max: MAX_SKILL_GAPS })
    .withMessage(
      `skill_gaps must contain 1-${MAX_SKILL_GAPS} items`
    ),

  body('skill_gaps.*')
    .isString()
    .trim()
    .notEmpty()
    .isLength({ max: MAX_SKILL_NAME })
    .withMessage(
      `Each skill gap must not exceed ${MAX_SKILL_NAME} characters`
    ),
];

const profileOptionalValidators = [
  body('role')
    .optional({ nullable: true })
    .isString()
    .trim()
    .isLength({ max: MAX_ROLE_LENGTH })
    .withMessage(
      `role must not exceed ${MAX_ROLE_LENGTH} characters`
    ),

  body('target_role')
    .optional({ nullable: true })
    .isString()
    .trim()
    .isLength({ max: MAX_ROLE_LENGTH })
    .withMessage(
      `target_role must not exceed ${MAX_ROLE_LENGTH} characters`
    ),

  body('skills')
    .optional()
    .isArray({ max: MAX_SKILLS })
    .withMessage(`skills must contain max ${MAX_SKILLS} items`),

  body('skills.*')
    .optional()
    .isString()
    .trim()
    .notEmpty()
    .isLength({ max: MAX_SKILL_NAME })
    .withMessage(
      `Each skill must not exceed ${MAX_SKILL_NAME} characters`
    ),
];

// ─────────────────────────────────────────────────────────────
// POST /recommendations
// ─────────────────────────────────────────────────────────────
router.post(
  '/recommendations',
  validate([
    ...skillGapsValidator,
    ...profileOptionalValidators,
  ]),
  asyncHandler(async (req, res) => {
    const userId = resolveUserId(req);
    const {
      skill_gaps,
      role,
      target_role,
      skills,
    } = req.body;

    logger.info('[LearningRoutes] Recommendations request', {
      userId,
      role,
      gap_count: skill_gaps.length,
    });

    const result = await recommendLearning(
      {
        role: role ?? null,
        target_role: target_role ?? null,
        skills: skills ?? [],
      },
      skill_gaps
    );

    return res.status(200).json({
      success: true,
      data: result,
    });
  })
);

// ─────────────────────────────────────────────────────────────
// POST /recommendations/from-profile
// ─────────────────────────────────────────────────────────────
router.post(
  '/recommendations/from-profile',
  validate([
    body('role')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: MAX_ROLE_LENGTH })
      .withMessage('role is required'),

    body('skills')
      .optional()
      .isArray({ max: MAX_SKILLS })
      .withMessage(`skills must contain max ${MAX_SKILLS} items`),

    body('skills.*')
      .optional()
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: MAX_SKILL_NAME })
      .withMessage(
        `Each skill must not exceed ${MAX_SKILL_NAME} characters`
      ),

    body('experience_years')
      .optional({ nullable: true })
      .isFloat({ min: 0, max: MAX_EXPERIENCE })
      .toFloat()
      .withMessage(
        `experience_years must be 0-${MAX_EXPERIENCE}`
      ),
  ]),
  asyncHandler(async (req, res) => {
    const userId = resolveUserId(req);
    const {
      role,
      skills = [],
      experience_years = 0,
    } = req.body;

    logger.info('[LearningRoutes] From-profile request', {
      userId,
      role,
      skill_count: skills.length,
    });

    let skillGaps = [];
    let demandResult = null;

    try {
      const { SkillDemandService } = require('../modules/skillDemand');
      const service = new SkillDemandService();

      demandResult = await service.analyzeSkillDemand({
        role,
        skills,
      });

      skillGaps = demandResult?.skill_gaps ?? [];
    } catch (error) {
      logger.warn(
        '[LearningRoutes] SkillDemand unavailable, skipping gap detection',
        {
          userId,
          role,
          error: error.message,
        }
      );
    }

    if (!skillGaps.length) {
      return res.status(200).json({
        success: true,
        data: {
          skill_gaps_detected: [],
          learning_recommendations: [],
          summary: {
            total_skills_addressed: 0,
            total_courses_found: 0,
            skills_without_courses: [],
          },
          meta: {
            engine_version: 'learning_v1',
            role,
            note:
              'No skill gaps detected or skill demand data unavailable for this role',
          },
        },
      });
    }

    const result = await recommendLearning(
      {
        role,
        skills,
        experience_years,
      },
      skillGaps
    );

    return res.status(200).json({
      success: true,
      data: {
        skill_gaps_detected: skillGaps,
        skill_score: demandResult?.skill_score ?? null,
        ...result,
      },
    });
  })
);

module.exports = router;