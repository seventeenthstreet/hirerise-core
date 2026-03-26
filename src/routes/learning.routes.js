'use strict';

/**
 * learning.routes.js — Learning Recommendation API Routes
 *
 * Mounted in server.js:
 *   app.use(`${API_PREFIX}/learning`, authenticate, require('./routes/learning.routes'));
 *
 * ┌──────────────────────────────────────────────────────────────────────────────┐
 * │ Method │ Path                          │ Description                         │
 * ├──────────────────────────────────────────────────────────────────────────────┤
 * │ POST   │ /recommendations              │ Recommend courses for skill gaps     │
 * │ POST   │ /recommendations/from-profile │ Detect gaps + recommend in one call  │
 * └──────────────────────────────────────────────────────────────────────────────┘
 *
 * @module routes/learning.routes
 */

const express          = require('express');
const { body }         = require('express-validator');
const { validate }     = require('../middleware/requestValidator');
const { asyncHandler } = require('../utils/helpers');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const { recommendLearning }    = require('../engines/learning.engine');
const logger = require('../utils/logger');

const router = express.Router();

// ─── Shared validators ────────────────────────────────────────────────────────

const skillGapsValidator = [
  body('skill_gaps')
    .isArray({ min: 1, max: 50 })
    .withMessage('skill_gaps must be a non-empty array with at most 50 items'),
  body('skill_gaps.*')
    .isString().trim().notEmpty()
    .withMessage('Each skill gap must be a non-empty string')
    .isLength({ max: 150 })
    .withMessage('Each skill name must not exceed 150 characters'),
];

const profileOptionalValidators = [
  body('role')
    .optional({ nullable: true })
    .isString().trim()
    .isLength({ max: 200 })
    .withMessage('role must not exceed 200 characters'),
  body('target_role')
    .optional({ nullable: true })
    .isString().trim()
    .isLength({ max: 200 })
    .withMessage('target_role must not exceed 200 characters'),
  body('skills')
    .optional()
    .isArray({ max: 100 })
    .withMessage('skills must be an array with at most 100 items'),
  body('skills.*')
    .optional()
    .isString().trim().notEmpty()
    .withMessage('Each skill must be a non-empty string')
    .isLength({ max: 150 }),
];

// ─── POST /recommendations ────────────────────────────────────────────────────

/**
 * POST /api/v1/learning/recommendations
 *
 * Core endpoint — takes a skill_gaps list and returns ranked course
 * recommendations for each skill.
 *
 * Request body:
 * {
 *   "skill_gaps":  ["Power BI", "SQL", "Machine Learning"],
 *   "role":        "Data Analyst",          // optional — for context/logging
 *   "target_role": "Senior Data Analyst"    // optional
 * }
 *
 * Response:
 * {
 *   "success": true,
 *   "data": {
 *     "learning_recommendations": [
 *       {
 *         "skill": "Power BI",
 *         "courses": [
 *           { "course_name": "...", "provider": "...", "level": "Beginner", "url": "..." }
 *         ]
 *       }
 *     ],
 *     "summary": { "total_skills_addressed": 3, "estimated_months": 2, ... },
 *     "meta":    { "engine_version": "learning_v1", ... }
 *   }
 * }
 */
router.post(
  '/recommendations',
  validate([...skillGapsValidator, ...profileOptionalValidators]),
  asyncHandler(async (req, res) => {
    const { skill_gaps, role, target_role, skills } = req.body;

    logger.info('[LearningRoutes] Recommendations request', {
      user_id:     req.user?.uid,
      role,
      gap_count:  skill_gaps.length,
    });

    const result = await recommendLearning(
      { role: role ?? null, target_role: target_role ?? null, skills: skills ?? [] },
      skill_gaps
    );

    return res.status(200).json({ success: true, data: result });
  })
);

// ─── POST /recommendations/from-profile ──────────────────────────────────────

/**
 * POST /api/v1/learning/recommendations/from-profile
 *
 * Combined endpoint — detects skill gaps from the Skill Demand engine,
 * then immediately returns learning recommendations for those gaps.
 *
 * Useful for frontend flows where the user hasn't explicitly run a skill gap
 * analysis first. Internally calls skillDemand.analyzeSkillDemand() and
 * feeds the gaps into the learning engine.
 *
 * Request body:
 * {
 *   "role":             "Junior Accountant",
 *   "skills":           ["Excel", "Tally"],
 *   "experience_years": 2
 * }
 *
 * Response includes both the detected gaps and the courses.
 */
router.post(
  '/recommendations/from-profile',
  validate([
    body('role')
      .isString().trim().notEmpty()
      .withMessage('role is required')
      .isLength({ max: 200 }),
    body('skills')
      .optional()
      .isArray({ max: 100 })
      .withMessage('skills must be an array'),
    body('skills.*')
      .optional()
      .isString().trim().notEmpty()
      .isLength({ max: 150 }),
    body('experience_years')
      .optional({ nullable: true })
      .isFloat({ min: 0, max: 60 })
      .toFloat(),
  ]),
  asyncHandler(async (req, res) => {
    const { role, skills = [], experience_years = 0 } = req.body;

    logger.info('[LearningRoutes] From-profile request', {
      user_id: req.user?.uid,
      role,
      skill_count: skills.length,
    });

    // ── Step 1: Detect skill gaps via skillDemand engine ────────────────────
    let skillGaps = [];
    let demandResult = null;

    try {
      const { SkillDemandService } = require('../modules/skillDemand');
      const svc = new SkillDemandService();
      demandResult = await svc.analyzeSkillDemand({ role, skills });
      skillGaps    = demandResult.skill_gaps ?? [];
    } catch (err) {
      // SkillDemand engine unavailable — proceed without detected gaps
      logger.warn('[LearningRoutes] SkillDemand unavailable, skipping gap detection:', err.message);
    }

    if (skillGaps.length === 0) {
      return res.status(200).json({
        success: true,
        data: {
          skill_gaps_detected:    [],
          learning_recommendations: [],
          summary: { total_skills_addressed: 0, total_courses_found: 0, skills_without_courses: [] },
          meta: {
            engine_version: 'learning_v1',
            role,
            note: 'No skill gaps detected or skill demand data unavailable for this role',
          },
        },
      });
    }

    // ── Step 2: Generate learning recommendations ────────────────────────────
    const result = await recommendLearning(
      { role, skills, experience_years },
      skillGaps
    );

    return res.status(200).json({
      success: true,
      data: {
        skill_gaps_detected:      skillGaps,
        skill_score:              demandResult?.skill_score ?? null,
        ...result,
      },
    });
  })
);

module.exports = router;








