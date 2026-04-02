'use strict';

/**
 * careerGraph.routes.js — Career Graph Intelligence API Routes
 */

const express = require('express');
const { body, param, query } = require('express-validator');
const { validate } = require('../../middleware/requestValidator');
const ctrl = require('./careerGraph.controller');

const router = express.Router();

const VALID_EDU_LEVELS = [
  'high_school',
  'diploma',
  'bachelors',
  'masters',
  'mba',
  'phd',
];

const VALID_TYPES = ['vertical', 'lateral', 'diagonal'];

const normalizeRoleId = (value) =>
  String(value || '').trim().toLowerCase();

// ── GET /roles ────────────────────────────────────────────────────────────────
router.get(
  '/roles',
  validate([
    query('q').optional().isString().trim().isLength({ max: 100 }),
    query('family').optional().isString().trim().isLength({ max: 100 }),
    query('limit').optional().isInt({ min: 1, max: 50 }).toInt(),
  ]),
  ctrl.searchRoles
);

// ── GET /families ─────────────────────────────────────────────────────────────
router.get('/families', ctrl.getFamilies);

// ── GET /roles/:roleId ────────────────────────────────────────────────────────
router.get(
  '/roles/:roleId',
  validate([
    param('roleId')
      .customSanitizer(normalizeRoleId)
      .isString()
      .notEmpty()
      .isLength({ max: 100 }),
  ]),
  ctrl.getRole
);

// ── GET /roles/:roleId/skills ─────────────────────────────────────────────────
router.get(
  '/roles/:roleId/skills',
  validate([
    param('roleId')
      .customSanitizer(normalizeRoleId)
      .isString()
      .notEmpty()
      .isLength({ max: 100 }),
  ]),
  ctrl.getRoleSkills
);

// ── GET /roles/:roleId/transitions ────────────────────────────────────────────
router.get(
  '/roles/:roleId/transitions',
  validate([
    param('roleId')
      .customSanitizer(normalizeRoleId)
      .isString()
      .notEmpty()
      .isLength({ max: 100 }),
    query('types')
      .optional()
      .custom((v) => v.split(',').every((p) => VALID_TYPES.includes(p.trim())))
      .withMessage(`types must be from: ${VALID_TYPES.join(', ')}`),
    query('maxDifficulty').optional().isInt({ min: 0, max: 100 }).toInt(),
  ]),
  ctrl.getTransitions
);

// ── GET /roles/:roleId/path ───────────────────────────────────────────────────
router.get(
  '/roles/:roleId/path',
  validate([
    param('roleId')
      .customSanitizer(normalizeRoleId)
      .isString()
      .notEmpty()
      .isLength({ max: 100 }),
    query('maxHops').optional().isInt({ min: 1, max: 6 }).toInt(),
    query('types')
      .optional()
      .custom((v) => v.split(',').every((p) => VALID_TYPES.includes(p.trim())))
      .withMessage(`types must be from: ${VALID_TYPES.join(', ')}`),
    query('maxDifficulty').optional().isInt({ min: 0, max: 100 }).toInt(),
  ]),
  ctrl.getCareerPath
);

// ── GET /roles/:roleId/salary ─────────────────────────────────────────────────
router.get(
  '/roles/:roleId/salary',
  validate([
    param('roleId')
      .customSanitizer(normalizeRoleId)
      .isString()
      .notEmpty()
      .isLength({ max: 100 }),
    query('country').optional().isString().trim().isLength({ max: 10 }),
    query('experienceYears').optional().isFloat({ min: 0, max: 60 }).toFloat(),
    query('currency').optional().isIn(['INR', 'USD', 'AED', 'GBP', 'EUR']),
  ]),
  ctrl.getSalaryBenchmark
);

// ── GET /roles/:roleId/education ─────────────────────────────────────────────
router.get(
  '/roles/:roleId/education',
  validate([
    param('roleId')
      .customSanitizer(normalizeRoleId)
      .isString()
      .notEmpty()
      .isLength({ max: 100 }),
    query('level')
      .optional()
      .isIn(VALID_EDU_LEVELS)
      .withMessage(`level must be one of: ${VALID_EDU_LEVELS.join(', ')}`),
  ]),
  ctrl.getEducationMatch
);

// ── POST /skill-gap ───────────────────────────────────────────────────────────
router.post(
  '/skill-gap',
  validate([
    body('roleId').isString().trim().notEmpty(),
    body('userSkills').isArray({ max: 100 }),
  ]),
  ctrl.getSkillGap
);

// ── POST /chi ─────────────────────────────────────────────────────────────────
router.post(
  '/chi',
  validate([
    body().custom((_, { req }) => {
      if (!req.body.targetRoleId && !req.body.targetRoleName) {
        throw new Error('targetRoleId or targetRoleName is required');
      }
      return true;
    }),
    body('experienceYears').optional().isFloat({ min: 0, max: 60 }).toFloat(),
    body('educationLevel').optional().isIn(VALID_EDU_LEVELS),
  ]),
  ctrl.computeCHI
);

// ── POST /onboarding-insights ─────────────────────────────────────────────────
router.post(
  '/onboarding-insights',
  validate([
    body().custom((_, { req }) => {
      if (!req.body.targetRoleId && !req.body.targetRoleName) {
        throw new Error('targetRoleId or targetRoleName is required');
      }
      return true;
    }),
    body('experienceYears').optional().isFloat({ min: 0, max: 60 }).toFloat(),
    body('educationLevel').optional().isIn(VALID_EDU_LEVELS),
  ]),
  ctrl.computeOnboardingInsights
);

module.exports = router;