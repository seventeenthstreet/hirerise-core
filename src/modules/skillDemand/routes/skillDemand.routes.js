'use strict';

/**
 * skillDemand.routes.js — Skill Demand Intelligence API Routes
 *
 * Mounted by server.js:
 *   app.use(`${API_PREFIX}/skills`, authenticate, skillDemandRouter);
 */

const express = require('express');
const { body, query, param } = require('express-validator');

const { validate } = require('../../../middleware/requestValidator');
const { asyncHandler } = require('../../../utils/helpers');
const {
  AppError,
  ErrorCodes,
} = require('../../../middleware/errorHandler');

const {
  SkillDemandService,
} = require('../service/skillDemand.service');

const router = express.Router();
const service = new SkillDemandService();

const ROLE_MAX_LENGTH = 200;
const INDUSTRY_MAX_LENGTH = 100;
const MAX_SKILLS_INPUT = 200;
const DEFAULT_TOP_SKILLS_LIMIT = 20;
const MAX_TOP_SKILLS_LIMIT = 100;

/**
 * Extract authenticated user id from normalized auth middleware.
 *
 * Supabase-native convention: req.user.id
 * Backward compatibility preserved for legacy middleware during rollout.
 *
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function getAuthenticatedUserId(req) {
  return req.user?.id || req.user?.uid || null;
}

// ─────────────────────────────────────────────
// POST /analyze
// ─────────────────────────────────────────────
router.post(
  '/analyze',
  validate([
    body('role')
      .isString()
      .trim()
      .notEmpty()
      .withMessage('role is required')
      .isLength({ max: ROLE_MAX_LENGTH })
      .withMessage(`role must be under ${ROLE_MAX_LENGTH} characters`),

    body('skills')
      .optional()
      .isArray({ max: MAX_SKILLS_INPUT })
      .withMessage(
        `skills must be an array (max ${MAX_SKILLS_INPUT} items)`
      ),

    body('skills.*')
      .optional()
      .custom(
        (value) =>
          typeof value === 'string' ||
          (typeof value === 'object' &&
            value !== null &&
            typeof value.name === 'string')
      )
      .withMessage('Each skill must be a string or { name: string }'),
  ]),
  asyncHandler(async (req, res) => {
    const { role, skills = [] } = req.body;
    const userId = getAuthenticatedUserId(req);

    const result = await service.analyzeSkillDemand({
      role,
      skills,
      userId,
    });

    res.status(200).json({
      success: true,
      data: result,
    });
  })
);

// ─────────────────────────────────────────────
// GET /demand/top
// ─────────────────────────────────────────────
router.get(
  '/demand/top',
  validate([
    query('industry')
      .optional()
      .isString()
      .trim()
      .isLength({ max: INDUSTRY_MAX_LENGTH }),

    query('limit')
      .optional()
      .isInt({ min: 1, max: MAX_TOP_SKILLS_LIMIT })
      .toInt(),
  ]),
  asyncHandler(async (req, res) => {
    const { industry, limit } = req.query;

    const skills = await service.getTopDemandSkills({
      industry: industry || undefined,
      limit: limit || DEFAULT_TOP_SKILLS_LIMIT,
    });

    res.status(200).json({
      success: true,
      data: {
        skills,
        count: skills.length,
      },
    });
  })
);

// ─────────────────────────────────────────────
// GET /demand/role/:role
// ─────────────────────────────────────────────
router.get(
  '/demand/role/:role',
  validate([
    param('role')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: ROLE_MAX_LENGTH }),
  ]),
  asyncHandler(async (req, res) => {
    const { role } = req.params;

    const skills = await service.getRequiredSkillsForRole(role);

    if (!skills?.length) {
      throw new AppError(
        `No skill data found for role: ${role}`,
        404,
        { role },
        ErrorCodes.NOT_FOUND
      );
    }

    res.status(200).json({
      success: true,
      data: {
        role,
        skills,
        count: skills.length,
      },
    });
  })
);

// ─────────────────────────────────────────────
// GET /demand/history
// ─────────────────────────────────────────────
router.get(
  '/demand/history',
  asyncHandler(async (req, res) => {
    const userId = getAuthenticatedUserId(req);

    if (!userId) {
      throw new AppError(
        'Authentication required',
        401,
        {},
        ErrorCodes.UNAUTHORIZED
      );
    }

    const history = await service.getUserAnalysisHistory(userId);

    res.status(200).json({
      success: true,
      data: {
        history,
        count: history.length,
      },
    });
  })
);

module.exports = router;