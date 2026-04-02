'use strict';

/**
 * modules/career-digital-twin/routes/digitalTwin.routes.js
 *
 * Route definitions for the Career Digital Twin module.
 *
 * Mounted at:
 *   /api/career
 *
 * Auth:
 *   Applied at mount point. Every handler expects req.user.
 */

const express = require('express');
const { body, query, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');

const {
  runSimulation,
  getSimulations,
  getFuturePaths,
  invalidateCache,
} = require('../controllers/digitalTwin.controller');

const router = express.Router();

const MAX_REQUESTS_PER_MINUTE = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_LIMIT = 50;

/**
 * Stable user-aware limiter key.
 * Supports both legacy uid and Supabase id middleware shapes.
 */
function getRateLimitKey(req) {
  return (
    req.user?.id ??
    req.user?.uid ??
    req.ip ??
    'anonymous'
  );
}

const simulationLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: MAX_REQUESTS_PER_MINUTE,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getRateLimitKey,
  skip: () => process.env.NODE_ENV === 'test',
  message: {
    success: false,
    error: `Simulation rate limit exceeded. Max ${MAX_REQUESTS_PER_MINUTE} requests per minute.`,
  },
});

/**
 * Shared validation middleware wrapper.
 */
function validate(rules) {
  return [
    ...rules,
    (req, res, next) => {
      const errors = validationResult(req);

      if (!errors.isEmpty()) {
        return res.status(422).json({
          success: false,
          error: 'Validation failed',
          details: errors.array({
            onlyFirstError: true,
          }),
        });
      }

      return next();
    },
  ];
}

// ───────────────────────────────────────────────────────────────────────────────
// POST /simulations
// ───────────────────────────────────────────────────────────────────────────────

router.post(
  '/simulations',
  simulationLimiter,
  validate([
    body('userProfile')
      .exists()
      .isObject()
      .withMessage('userProfile must be an object'),

    body('userProfile.role')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: 120 })
      .withMessage('userProfile.role is required (max 120 chars)'),

    body('userProfile.skills')
      .optional()
      .isArray({ max: MAX_LIMIT })
      .withMessage(`userProfile.skills must be an array (max ${MAX_LIMIT} items)`),

    body('userProfile.skills.*')
      .optional()
      .isString()
      .trim()
      .isLength({ max: 80 })
      .withMessage('Each skill must be a string (max 80 chars)'),

    body('userProfile.experience_years')
      .optional()
      .isFloat({ min: 0, max: 50 })
      .withMessage('experience_years must be a number 0–50'),

    body('userProfile.industry')
      .optional()
      .isString()
      .trim()
      .isLength({ max: 100 })
      .withMessage('industry must be a string (max 100 chars)'),

    body('userProfile.salary_current')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('salary_current must be a positive number'),

    body('includeNarrative')
      .optional()
      .isBoolean()
      .toBoolean()
      .withMessage('includeNarrative must be a boolean'),

    body('forceRefresh')
      .optional()
      .isBoolean()
      .toBoolean()
      .withMessage('forceRefresh must be a boolean'),
  ]),
  runSimulation
);

// ───────────────────────────────────────────────────────────────────────────────
// GET /simulations
// ───────────────────────────────────────────────────────────────────────────────

router.get(
  '/simulations',
  validate([
    query('limit')
      .optional()
      .isInt({ min: 1, max: MAX_LIMIT })
      .toInt()
      .withMessage(`limit must be an integer 1–${MAX_LIMIT}`),
  ]),
  getSimulations
);

// ───────────────────────────────────────────────────────────────────────────────
// GET /future-paths
// ───────────────────────────────────────────────────────────────────────────────

router.get(
  '/future-paths',
  simulationLimiter,
  validate([
    query('role')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: 120 })
      .withMessage('Query param "role" is required (max 120 chars)'),

    query('skills')
      .optional()
      .isString()
      .withMessage('skills must be a comma-separated string'),

    query('experience_years')
      .optional()
      .isFloat({ min: 0, max: 50 })
      .withMessage('experience_years must be a number 0–50'),

    query('industry')
      .optional()
      .isString()
      .trim()
      .isLength({ max: 100 })
      .withMessage('industry must be a string (max 100 chars)'),
  ]),
  getFuturePaths
);

// ───────────────────────────────────────────────────────────────────────────────
// DELETE /simulations/cache
// ───────────────────────────────────────────────────────────────────────────────

router.delete(
  '/simulations/cache',
  validate([
    body('role')
      .optional()
      .isString()
      .trim()
      .isLength({ max: 120 })
      .withMessage('role must be a string (max 120 chars)'),
  ]),
  invalidateCache
);

module.exports = router;