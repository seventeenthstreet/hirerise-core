'use strict';

/**
 * chiV2.routes.js
 *
 * Mounted:
 * app.use(`${API_PREFIX}/chi-v2`, authenticate, require('./src/modules/chiv2/chiV2.routes'));
 *
 * Routes:
 * POST /calculate
 * POST /skill-gap
 * POST /career-path
 * POST /opportunities
 * POST /full-intelligence
 * GET  /benchmark
 */

const express = require('express');
const { body } = require('express-validator');
const { validate } = require('../../middleware/requestValidator');
const ctrl = require('./chiV2.controller');
const benchmarkCtrl = require('./chiBenchmark.controller');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const ROUTES = Object.freeze({
  CALCULATE: '/calculate',
  SKILL_GAP: '/skill-gap',
  CAREER_PATH: '/career-path',
  OPPORTUNITIES: '/opportunities',
  FULL_INTELLIGENCE: '/full-intelligence',
  BENCHMARK: '/benchmark',
});

const VALID_EDUCATION = Object.freeze([
  'none',
  'high_school',
  'diploma',
  'bachelors',
  'masters',
  'mba', // preserved for backward compatibility
  'phd'
]);

const VALID_LEVELS = Object.freeze([
  'beginner',
  'intermediate',
  'advanced',
  'expert'
]);

// ─────────────────────────────────────────────────────────────────────────────
// Shared Validators
// ─────────────────────────────────────────────────────────────────────────────

const profileValidators = Object.freeze([
  body('target_role')
    .optional({ nullable: true })
    .isString()
    .trim()
    .isLength({ max: 200 }),

  body('current_role')
    .optional({ nullable: true })
    .isString()
    .trim()
    .isLength({ max: 200 }),

  body('skills')
    .optional()
    .isArray({ max: 100 }),

  body('skills.*')
    .optional()
    .isString()
    .trim()
    .notEmpty()
    .isLength({ max: 100 }),

  body('skill_levels')
    .optional()
    .isArray({ max: 100 }),

  body('skill_levels.*.skill')
    .optional()
    .isString()
    .trim()
    .notEmpty()
    .isLength({ max: 100 }),

  body('skill_levels.*.level')
    .optional()
    .isString()
    .isIn(VALID_LEVELS),

  body('education_level')
    .optional({ nullable: true })
    .isString()
    .isIn(VALID_EDUCATION),

  body('years_experience')
    .optional({ nullable: true })
    .isFloat({ min: 0, max: 60 })
    .toFloat(),

  body('current_salary')
    .optional({ nullable: true })
    .isFloat({ min: 0 })
    .toFloat(),

  body('country')
    .optional({ nullable: true })
    .isString()
    .trim()
    .isLength({ max: 100 }),

  body('top_n')
    .optional({ nullable: true })
    .isInt({ min: 1, max: 10 })
    .toInt()
]);

const validateProfile = validate(profileValidators);

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

router.post(ROUTES.CALCULATE, validateProfile, ctrl.calculate);

router.post(ROUTES.SKILL_GAP, validateProfile, ctrl.skillGap);

router.post(ROUTES.CAREER_PATH, validateProfile, ctrl.careerPath);

router.post(ROUTES.OPPORTUNITIES, validateProfile, ctrl.opportunities);

router.post(
  ROUTES.FULL_INTELLIGENCE,
  validateProfile,
  ctrl.fullIntelligence
);

// GET /api/v1/chi-v2/benchmark
// Returns the authenticated user's latest CHI cohort benchmark + trend history.
// No body required — userId sourced from req.user.id (set by authenticate middleware).
router.get(ROUTES.BENCHMARK, benchmarkCtrl.getUserBenchmarkAnalytics);

module.exports = router;