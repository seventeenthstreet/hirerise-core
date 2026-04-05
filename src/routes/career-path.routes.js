'use strict';

/**
 * routes/career-path.routes.js
 * Standalone Career Path Prediction Routes
 *
 * Mounted at:
 * /api/v1/career-path
 */

const express = require('express');
const { body, param, query } = require('express-validator');

const { validate } = require('../middleware/requestValidator');
const {
  predictCareerPath,
  getProgressionChain,
} = require('../engines/career-path.engine');
const logger = require('../utils/logger');

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────
const MAX_ROLE_LENGTH = 200;
const MAX_SKILLS = 100;
const MAX_SKILL_LENGTH = 150;
const MAX_INDUSTRY_LENGTH = 100;
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
// Validation
// ─────────────────────────────────────────────────────────────
const predictValidation = [
  body('role')
    .isString()
    .trim()
    .notEmpty()
    .isLength({ min: 1, max: MAX_ROLE_LENGTH })
    .withMessage(
      `role must be between 1 and ${MAX_ROLE_LENGTH} characters`
    ),

  body('experience_years')
    .optional({ nullable: true })
    .isFloat({ min: 0, max: MAX_EXPERIENCE })
    .toFloat()
    .withMessage(
      `experience_years must be between 0 and ${MAX_EXPERIENCE}`
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
    .isLength({ max: MAX_SKILL_LENGTH })
    .withMessage(
      `Each skill name must not exceed ${MAX_SKILL_LENGTH} characters`
    ),

  body('industry')
    .optional({ nullable: true })
    .isString()
    .trim()
    .isLength({ max: MAX_INDUSTRY_LENGTH })
    .withMessage(
      `industry must not exceed ${MAX_INDUSTRY_LENGTH} characters`
    ),
];

const chainValidation = [
  param('role')
    .isString()
    .trim()
    .notEmpty()
    .isLength({ max: MAX_ROLE_LENGTH })
    .withMessage('role param is required'),

  query('industry')
    .optional()
    .isString()
    .trim()
    .isLength({ max: MAX_INDUSTRY_LENGTH })
    .withMessage(
      `industry must not exceed ${MAX_INDUSTRY_LENGTH} characters`
    ),
];

// ─────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────
async function handlePredict(req, res, next) {
  try {
    const { role, experience_years, skills, industry } = req.body;
    const userId = resolveUserId(req);

    logger.info('[CareerPathRoutes] Predict request', {
      userId,
      role,
      experience_years,
    });

    const result = await predictCareerPath({
      role,
      experience_years: experience_years ?? 0,
      skills: skills ?? [],
      industry: industry ?? null,
    });

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error('[CareerPathRoutes] Predict failed', {
      userId: resolveUserId(req),
      role: req?.body?.role ?? null,
      error: error.message,
    });

    return next(error);
  }
}

async function handleGetChain(req, res, next) {
  try {
    const role = req.params.role.trim();
    const industry = req.query.industry?.trim() ?? null;

    const chain = await getProgressionChain(role, industry);

    return res.status(200).json({
      success: true,
      data: {
        role,
        chain,
        steps: chain.length,
      },
    });
  } catch (error) {
    logger.error('[CareerPathRoutes] Chain lookup failed', {
      role: req?.params?.role ?? null,
      error: error.message,
    });

    return next(error);
  }
}

// ─────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────
router.post(
  '/predict',
  validate(predictValidation),
  handlePredict
);

router.get(
  '/chain/:role',
  validate(chainValidation),
  handleGetChain
);

module.exports = router;