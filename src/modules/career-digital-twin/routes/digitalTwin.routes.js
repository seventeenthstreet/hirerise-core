'use strict';

/**
 * modules/career-digital-twin/routes/digitalTwin.routes.js
 *
 * Route definitions for the Career Digital Twin module.
 *
 * All routes are prefixed with /api/career (mounted in server.js).
 * Auth is applied at the mount point — every handler receives req.user.
 *
 * Route summary:
 * ┌─────────────────────────────────────────┬──────────────────────────────────────────────────┐
 * │ Method + Path                           │ Description                                      │
 * ├─────────────────────────────────────────┼──────────────────────────────────────────────────┤
 * │ POST   /api/career/simulations          │ Run a new simulation (full, with optional AI)    │
 * │ GET    /api/career/simulations          │ Retrieve simulation history for the user          │
 * │ GET    /api/career/future-paths         │ Quick simulation via query params                 │
 * │ DELETE /api/career/simulations/cache    │ Bust the user's Redis simulation cache            │
 * └─────────────────────────────────────────┴──────────────────────────────────────────────────┘
 *
 * Registration in server.js (add before the 404 handler):
 *
 *   const digitalTwinRouter = require('./modules/career-digital-twin/routes/digitalTwin.routes');
 *   app.use(`${API_PREFIX}/career`, authenticate, digitalTwinRouter);
 *
 * NOTE: If /api/career is already mounted by career.routes.js you should instead
 * require this router from within career.routes.js and call:
 *
 *   router.use('/', digitalTwinRouter);
 */

const express    = require('express');
const { body, query, validationResult } = require('express-validator');
const rateLimit  = require('express-rate-limit');

const {
  runSimulation,
  getSimulations,
  getFuturePaths,
  invalidateCache,
} = require('../controllers/digitalTwin.controller');

const router = express.Router();

// ─── Rate limiter ─────────────────────────────────────────────────────────────
// Simulation is AI + compute heavy — cap at 20 req/min per user
const simulationLimiter = rateLimit({
  windowMs:  60 * 1000,
  max:        20,
  keyGenerator: (req) => req.user?.uid || req.ip,
  message: {
    success: false,
    error:   'Simulation rate limit exceeded. Max 20 requests per minute.',
  },
  skip: () => process.env.NODE_ENV === 'test',
});

// ─── Validation middleware helper ─────────────────────────────────────────────

function validate(rules) {
  return [
    ...rules,
    (req, res, next) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(422).json({
          success: false,
          error:   'Validation failed',
          details: errors.array(),
        });
      }
      next();
    },
  ];
}

// ─── POST /simulations ────────────────────────────────────────────────────────

router.post(
  '/simulations',
  simulationLimiter,
  validate([
    body('userProfile')
      .isObject()
      .withMessage('userProfile must be an object'),

    body('userProfile.role')
      .isString().trim().notEmpty().isLength({ max: 120 })
      .withMessage('userProfile.role is required (max 120 chars)'),

    body('userProfile.skills')
      .optional()
      .isArray({ max: 50 })
      .withMessage('userProfile.skills must be an array (max 50 items)'),

    body('userProfile.skills.*')
      .optional()
      .isString().trim().isLength({ max: 80 })
      .withMessage('Each skill must be a string (max 80 chars)'),

    body('userProfile.experience_years')
      .optional()
      .isFloat({ min: 0, max: 50 })
      .withMessage('experience_years must be a number 0–50'),

    body('userProfile.industry')
      .optional()
      .isString().trim().isLength({ max: 100 })
      .withMessage('industry must be a string (max 100 chars)'),

    body('userProfile.salary_current')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('salary_current must be a positive number'),

    body('includeNarrative')
      .optional()
      .isBoolean()
      .withMessage('includeNarrative must be a boolean'),

    body('forceRefresh')
      .optional()
      .isBoolean()
      .withMessage('forceRefresh must be a boolean'),
  ]),
  runSimulation
);

// ─── GET /simulations ─────────────────────────────────────────────────────────

router.get(
  '/simulations',
  validate([
    query('limit')
      .optional()
      .isInt({ min: 1, max: 50 })
      .toInt()
      .withMessage('limit must be an integer 1–50'),
  ]),
  getSimulations
);

// ─── GET /future-paths ────────────────────────────────────────────────────────

router.get(
  '/future-paths',
  simulationLimiter,
  validate([
    query('role')
      .isString().trim().notEmpty().isLength({ max: 120 })
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
      .isString().trim().isLength({ max: 100 })
      .withMessage('industry must be a string (max 100 chars)'),
  ]),
  getFuturePaths
);

// ─── DELETE /simulations/cache ────────────────────────────────────────────────

router.delete(
  '/simulations/cache',
  validate([
    body('role')
      .optional()
      .isString().trim().isLength({ max: 120 })
      .withMessage('role must be a string (max 120 chars)'),
  ]),
  invalidateCache
);

module.exports = router;









