'use strict';

/**
 * routes/growth.routes.js
 *
 * Endpoints:
 *   GET /api/v1/growth/projection
 *   GET /api/v1/growth/projected
 */

const express = require('express');
const { query } = require('express-validator');

const { validate } = require('../middleware/requestValidator');
const growthService = require('../modules/growth/growth.service');
const logger = require('../utils/logger');

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────
const DEFAULT_YEARS = 5;
const MAX_YEARS = 20;
const MAX_ROLE_ID_LENGTH = 100;
const MAX_EXPERIENCE_YEARS = 60;

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
const projectionValidation = [
  query('targetRoleId')
    .isString()
    .trim()
    .notEmpty()
    .isLength({ max: MAX_ROLE_ID_LENGTH })
    .withMessage('targetRoleId is required'),

  query('years')
    .optional()
    .isInt({ min: 1, max: MAX_YEARS })
    .toInt()
    .withMessage(`years must be between 1 and ${MAX_YEARS}`),

  query('currentExperienceYears')
    .optional()
    .isInt({ min: 0, max: MAX_EXPERIENCE_YEARS })
    .toInt()
    .withMessage(
      `currentExperienceYears must be 0-${MAX_EXPERIENCE_YEARS}`
    ),
];

// ─────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────
async function handleProjection(req, res, next) {
  try {
    const userId = resolveUserId(req);

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required.',
        },
      });
    }

    const targetRoleId = req.query.targetRoleId;
    const years = req.query.years ?? DEFAULT_YEARS;
    const currentExperienceYears =
      req.query.currentExperienceYears ?? 0;

    logger.info('[GrowthRoutes] Projection request', {
      userId,
      targetRoleId,
      years,
      currentExperienceYears,
    });

    const result = await growthService.generateProjection({
      userId,
      targetRoleId,
      years,
      currentExperienceYears,
    });

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error('[GrowthRoutes] Projection failed', {
      userId: resolveUserId(req),
      targetRoleId: req?.query?.targetRoleId ?? null,
      error: error.message,
    });

    return next(error);
  }
}

// ─────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────
router.get(
  '/projection',
  validate(projectionValidation),
  handleProjection
);

router.get(
  '/projected',
  validate(projectionValidation),
  handleProjection
);

module.exports = router;