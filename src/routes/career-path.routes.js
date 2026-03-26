'use strict';

/**
 * career-path.routes.js — Standalone Career Path Prediction Routes
 *
 * Mounted in server.js:
 *   app.use(`${API_PREFIX}/career-path`, authenticate, require('./routes/career-path.routes'));
 *
 * ┌────────────────────────────────────────────────────────────────────────┐
 * │ Method │ Path                          │ Description                   │
 * ├────────────────────────────────────────────────────────────────────────┤
 * │ POST   │ /predict                      │ Predict full career path       │
 * │ GET    │ /chain/:role                  │ Raw progression chain for role │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * All routes require authenticate middleware (applied in server.js).
 *
 * @module routes/career-path.routes
 */

const express       = require('express');
const { body, param } = require('express-validator');
const { validate }    = require('../middleware/requestValidator');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const { predictCareerPath, getProgressionChain } = require('../engines/career-path.engine');
const logger = require('../utils/logger');

const router = express.Router();

// ─── Validation schemas ───────────────────────────────────────────────────────

const predictValidation = [
  body('role')
    .isString().trim().notEmpty()
    .withMessage('role is required and must be a non-empty string')
    .isLength({ min: 1, max: 200 })
    .withMessage('role must be between 1 and 200 characters'),

  body('experience_years')
    .optional({ nullable: true })
    .isFloat({ min: 0, max: 60 })
    .withMessage('experience_years must be a number between 0 and 60')
    .toFloat(),

  body('skills')
    .optional()
    .isArray({ max: 100 })
    .withMessage('skills must be an array with at most 100 items'),

  body('skills.*')
    .optional()
    .isString().trim().notEmpty()
    .withMessage('Each skill must be a non-empty string')
    .isLength({ max: 150 })
    .withMessage('Each skill name must not exceed 150 characters'),

  body('industry')
    .optional({ nullable: true })
    .isString().trim()
    .isLength({ max: 100 })
    .withMessage('industry must be a string up to 100 characters'),
];

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/career-path/predict
 *
 * Predicts the full career progression chain from a user's current role.
 * Accounts for existing experience to adjust the timeline.
 *
 * Request body:
 * {
 *   "role": "Junior Accountant",
 *   "experience_years": 2,
 *   "skills": ["Excel", "Tally"],    // optional — future: skill-gated transitions
 *   "industry": "Finance"            // optional — prefers industry-matching paths
 * }
 *
 * Response:
 * {
 *   "success": true,
 *   "data": {
 *     "current_role": "Junior Accountant",
 *     "experience_years": 2,
 *     "career_path": [
 *       { "role": "Senior Accountant", "estimated_years": 0.5, "years_to_reach": 0.5, ... },
 *       { "role": "Finance Manager",   "estimated_years": 3.5, "years_to_reach": 3 },
 *       ...
 *     ],
 *     "total_estimated_years": 11.5,
 *     "next_role": "Senior Accountant",
 *     "steps": 4,
 *     "source": "csv"
 *   }
 * }
 */
async function handlePredict(req, res, next) {
  try {
    const { role, experience_years, skills, industry } = req.body;

    logger.info('[CareerPathRoutes] Predict request', {
      user_id: req.user?.uid,
      role,
      experience_years,
    });

    const result = await predictCareerPath({
      role,
      experience_years: experience_years ?? 0,
      skills:           skills           ?? [],
      industry:         industry         ?? null,
    });

    return res.status(200).json({
      success: true,
      data:    result,
    });

  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/career-path/chain/:role
 *
 * Returns the raw progression chain for a given role from the CSV dataset.
 * Lightweight endpoint — no Firestore enrichment, no experience adjustment.
 * Useful for the frontend "Career Explorer" widget.
 *
 * Path param: role (URL-encoded, e.g. "Junior%20Accountant")
 *
 * Query param: industry (optional filter)
 *
 * Response:
 * {
 *   "success": true,
 *   "data": {
 *     "role": "Junior Accountant",
 *     "chain": [
 *       { "role": "Junior Accountant", "next_role": "Senior Accountant", "years_to_next": 2, ... },
 *       ...
 *     ],
 *     "steps": 4
 *   }
 * }
 */
async function handleGetChain(req, res, next) {
  try {
    const role     = decodeURIComponent(req.params.role || '').trim();
    const industry = req.query.industry?.trim() ?? null;

    if (!role) {
      throw new AppError('role param is required', 400, {}, ErrorCodes.VALIDATION_ERROR);
    }

    const chain = await getProgressionChain(role, industry);

    return res.status(200).json({
      success: true,
      data: {
        role,
        chain,
        steps: chain.length,
      },
    });

  } catch (err) {
    next(err);
  }
}

// ─── Route declarations ───────────────────────────────────────────────────────

/**
 * POST /api/v1/career-path/predict
 * Full career path prediction with experience adjustment and Firestore enrichment.
 */
router.post(
  '/predict',
  validate(predictValidation),
  handlePredict
);

/**
 * GET /api/v1/career-path/chain/:role
 * Raw CSV progression chain — fast, no Firestore.
 */
router.get(
  '/chain/:role',
  handleGetChain
);

module.exports = router;








