'use strict';

/**
 * routes/salary.routes.js
 * Salary Benchmark API Routes
 *
 * Mounted at:
 * /api/v1/salary
 */

const express = require('express');
const { body, param, query } = require('express-validator');

const { validate } = require('../middleware/requestValidator');
const salaryController = require('../controllers/salary.controller');
const { aiRateLimit } = require('../middleware/aiRateLimit.middleware');

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────
const MAX_ROLE_ID_LENGTH = 100;
const MAX_EXPERIENCE = 60;
const MAX_INDUSTRY_LENGTH = 50;

const VALID_LOCATIONS = Object.freeze([
  'metro',
  'tier1',
  'tier2',
  'tier3',
]);

// ─────────────────────────────────────────────────────────────
// POST /benchmark
// ─────────────────────────────────────────────────────────────
router.post(
  '/benchmark',
  aiRateLimit,
  validate([
    body('roleId')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: MAX_ROLE_ID_LENGTH })
      .withMessage(
        'roleId is required and must be a non-empty string'
      ),

    body('experienceYears')
      .isInt({ min: 0, max: MAX_EXPERIENCE })
      .toInt()
      .withMessage(
        `experienceYears must be between 0 and ${MAX_EXPERIENCE}`
      ),

    body('location')
      .optional({ nullable: true })
      .isString()
      .trim()
      .isIn(VALID_LOCATIONS)
      .withMessage(
        `location must be one of: ${VALID_LOCATIONS.join(', ')}`
      ),
  ]),
  salaryController.getBenchmark
);

// ─────────────────────────────────────────────────────────────
// POST /intelligence
// ─────────────────────────────────────────────────────────────
router.post(
  '/intelligence',
  aiRateLimit,
  validate([
    body('roleId')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: MAX_ROLE_ID_LENGTH })
      .withMessage('roleId is required'),

    body('experienceYears')
      .isInt({ min: 0, max: MAX_EXPERIENCE })
      .toInt()
      .withMessage(
        `experienceYears must be between 0 and ${MAX_EXPERIENCE}`
      ),

    body('location')
      .optional({ nullable: true })
      .isString()
      .trim()
      .isIn(VALID_LOCATIONS)
      .withMessage(
        `location must be one of: ${VALID_LOCATIONS.join(', ')}`
      ),

    body('industry')
      .optional({ nullable: true })
      .isString()
      .trim()
      .isLength({ max: MAX_INDUSTRY_LENGTH })
      .withMessage('industry must be a valid string'),

    body('currentSalary')
      .optional({ nullable: true })
      .isInt({ min: 0 })
      .toInt()
      .withMessage(
        'currentSalary must be a positive integer'
      ),
  ]),
  salaryController.getIntelligence
);

// ─────────────────────────────────────────────────────────────
// GET /bands/:roleId
// ─────────────────────────────────────────────────────────────
router.get(
  '/bands/:roleId',
  validate([
    param('roleId')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: MAX_ROLE_ID_LENGTH })
      .withMessage('roleId path parameter is required'),
  ]),
  salaryController.getSalaryBands
);

// ─────────────────────────────────────────────────────────────
// GET /compare
// ─────────────────────────────────────────────────────────────
router.get(
  '/compare',
  validate([
    query('roleIds')
      .notEmpty()
      .withMessage('roleIds query parameter is required')
      .customSanitizer((value) =>
        typeof value === 'string'
          ? value
              .split(',')
              .map((v) => v.trim())
              .filter(Boolean)
          : value
      )
      .isArray({ min: 2, max: 5 })
      .withMessage(
        'Provide between 2 and 5 roleIds for comparison'
      ),

    query('experienceYears')
      .optional()
      .isInt({ min: 0, max: MAX_EXPERIENCE })
      .toInt()
      .withMessage(
        `experienceYears must be between 0 and ${MAX_EXPERIENCE}`
      ),
  ]),
  salaryController.compareSalaries
);

module.exports = router;