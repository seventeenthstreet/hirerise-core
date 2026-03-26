/**
 * salary.routes.js — Salary Benchmark API Routes (Enterprise Hardened)
 *
 * Responsibilities:
 *   - Define URL paths and HTTP methods
 *   - Attach input validation chains
 *   - Delegate to controller (zero business logic here)
 *
 * All routes are prefixed with /api/v1/salary by server.js
 */

'use strict';

const express = require('express');
const { body, param, query } = require('express-validator');
const { validate } = require('../middleware/requestValidator');
const salaryController = require('../controllers/salary.controller');
const { aiRateLimit }  = require('../middleware/aiRateLimit.middleware'); // AI cost protection

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// POST /api/v1/salary/benchmark
// ─────────────────────────────────────────────────────────────
router.post(
  '/benchmark',
  aiRateLimit,          // burst protection — max 5 AI calls/60s per user
  validate([
    body('roleId')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: 100 })
      .withMessage('roleId is required and must be a non-empty string'),

    body('experienceYears')
      .isInt({ min: 0, max: 60 })
      .toInt()
      .withMessage('experienceYears must be an integer between 0 and 60'),

    body('location')
      .optional({ nullable: true })   // FIX: allow null, default to 'metro' in service
      .isString()
      .trim()
      .isIn(['metro', 'tier1', 'tier2', 'tier3'])
      .withMessage('location must be one of: metro, tier1, tier2, tier3'),
  ]),
  salaryController.getBenchmark
);

// ─────────────────────────────────────────────────────────────
// POST /api/v1/salary/intelligence
// ─────────────────────────────────────────────────────────────
// Advanced salary intelligence analysis
router.post(
  '/intelligence',
  aiRateLimit,          // burst protection — max 5 AI calls/60s per user
  validate([
    body('roleId')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: 100 })
      .withMessage('roleId is required'),

    body('experienceYears')
      .isInt({ min: 0, max: 60 })
      .toInt()
      .withMessage('experienceYears must be between 0 and 60'),

    body('location')
      .optional()
      .isString()
      .trim()
      .isIn(['metro', 'tier1', 'tier2', 'tier3'])
      .withMessage('location must be one of: metro, tier1, tier2, tier3'),

    body('industry')
      .optional({ nullable: true })   // FIX: frontend sends null explicitly
      .isString()
      .trim()
      .isLength({ max: 50 })
      .withMessage('industry must be a valid string'),

    body('currentSalary')
      .optional({ nullable: true })   // FIX: frontend sends null explicitly
      .isInt({ min: 0 })
      .toInt()
      .withMessage('currentSalary must be a positive integer'),
  ]),
  salaryController.getIntelligence
);

// ─────────────────────────────────────────────────────────────
// GET /api/v1/salary/bands/:roleId
// ─────────────────────────────────────────────────────────────
router.get(
  '/bands/:roleId',
  validate([
    param('roleId')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: 100 })
      .withMessage('roleId path parameter is required'),
  ]),
  salaryController.getSalaryBands
);

// ─────────────────────────────────────────────────────────────
// GET /api/v1/salary/compare
// ─────────────────────────────────────────────────────────────
router.get(
  '/compare',
  validate([
    query('roleIds')
      .notEmpty()
      .withMessage('roleIds query parameter is required')
      .customSanitizer(value =>
        typeof value === 'string'
          ? value.split(',').map(v => v.trim())
          : value
      )
      .isArray({ min: 2, max: 5 })
      .withMessage('Provide between 2 and 5 roleIds for comparison'),

    query('experienceYears')
      .optional()
      .isInt({ min: 0, max: 60 })
      .toInt()
      .withMessage('experienceYears must be an integer between 0 and 60'),
  ]),
  salaryController.compareSalaries
);

module.exports = router;








