'use strict';

/**
 * modules/education-intelligence/routes/careerPrediction.routes.js
 *
 * Education Intelligence — Career Success Probability Engine routes.
 *
 * Mounted at:
 * /api/v1/education
 */

const { Router } = require('express');
const { param } = require('express-validator');

const controller = require('../controllers/careerPrediction.controller');
const { validate } = require('../../../middleware/requestValidator');
const { asyncHandler } = require('../../../utils/helpers');

const router = Router();

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────
const MAX_STUDENT_ID_LENGTH = 100;

// ─────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────
const studentIdValidation = [
  param('studentId')
    .isString()
    .trim()
    .notEmpty()
    .isLength({ max: MAX_STUDENT_ID_LENGTH })
    .matches(/^[A-Za-z0-9_-]+$/)
    .withMessage(
      `studentId must be 1-${MAX_STUDENT_ID_LENGTH} chars and contain only letters, numbers, underscores, or hyphens`
    ),
];

// ─────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────

/**
 * POST /api/v1/education/career-prediction/:studentId
 * Run CSPE, persist, and return ranked top careers.
 */
router.post(
  '/career-prediction/:studentId',
  validate(studentIdValidation),
  asyncHandler(controller.predictCareers)
);

/**
 * GET /api/v1/education/career-prediction/:studentId
 * Return previously stored predictions.
 */
router.get(
  '/career-prediction/:studentId',
  validate(studentIdValidation),
  asyncHandler(controller.getCareers)
);

module.exports = router;