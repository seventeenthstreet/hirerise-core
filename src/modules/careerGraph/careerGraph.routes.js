'use strict';

/**
 * careerGraph.routes.js — Career Graph Intelligence API Routes
 *
 * All routes prefixed with /api/v1/career-graph by server.js:
 *   app.use(`${API_PREFIX}/career-graph`, authenticate, require('./routes/careerGraph.routes'));
 *
 * ┌──────────────────────────────────────────────────────────────────────────────────┐
 * │ Method │ Path                                  │ Description                     │
 * ├──────────────────────────────────────────────────────────────────────────────────┤
 * │ GET    │ /roles                                │ Search / list roles              │
 * │ GET    │ /families                             │ List job families               │
 * │ GET    │ /roles/:roleId                        │ Get role node                   │
 * │ GET    │ /roles/:roleId/skills                 │ Skills for a role               │
 * │ GET    │ /roles/:roleId/transitions            │ Outbound transitions            │
 * │ GET    │ /roles/:roleId/path                   │ Career path projection          │
 * │ GET    │ /roles/:roleId/salary                 │ Salary benchmark                │
 * │ GET    │ /roles/:roleId/education              │ Education match (with ?level=)  │
 * │ POST   │ /skill-gap                            │ Skill gap for user vs role      │
 * │ POST   │ /chi                                  │ Graph-powered CHI score         │
 * │ POST   │ /onboarding-insights                  │ Onboarding insight cards data   │
 * └──────────────────────────────────────────────────────────────────────────────────┘
 */

const express = require('express');
const { body, param, query } = require('express-validator');
const { validate }  = require('../../middleware/requestValidator');
const ctrl          = require('./careerGraph.controller');

const router = express.Router();

const VALID_EDU_LEVELS = ['high_school', 'diploma', 'bachelors', 'masters', 'mba', 'phd'];
const VALID_TYPES      = ['vertical', 'lateral', 'diagonal'];

// ── GET /roles ────────────────────────────────────────────────────────────────
router.get('/roles',
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
router.get('/roles/:roleId',
  validate([
    param('roleId').isString().trim().notEmpty().isLength({ max: 100 }),
  ]),
  ctrl.getRole
);

// ── GET /roles/:roleId/skills ─────────────────────────────────────────────────
router.get('/roles/:roleId/skills',
  validate([
    param('roleId').isString().trim().notEmpty().isLength({ max: 100 }),
  ]),
  ctrl.getRoleSkills
);

// ── GET /roles/:roleId/transitions ────────────────────────────────────────────
router.get('/roles/:roleId/transitions',
  validate([
    param('roleId').isString().trim().notEmpty().isLength({ max: 100 }),
    query('types')
      .optional()
      .custom(v => {
        const parts = v.split(',');
        return parts.every(p => VALID_TYPES.includes(p.trim()));
      })
      .withMessage(`types must be comma-separated values from: ${VALID_TYPES.join(', ')}`),
    query('minProbability').optional().isFloat({ min: 0, max: 1 }).toFloat(),
  ]),
  ctrl.getTransitions
);

// ── GET /roles/:roleId/path ───────────────────────────────────────────────────
router.get('/roles/:roleId/path',
  validate([
    param('roleId').isString().trim().notEmpty().isLength({ max: 100 }),
    query('maxHops').optional().isInt({ min: 1, max: 6 }).toInt(),
    query('types')
      .optional()
      .custom(v => v.split(',').every(p => VALID_TYPES.includes(p.trim())))
      .withMessage(`types must be from: ${VALID_TYPES.join(', ')}`),
    query('minProbability').optional().isFloat({ min: 0, max: 1 }).toFloat(),
  ]),
  ctrl.getCareerPath
);

// ── GET /roles/:roleId/salary ─────────────────────────────────────────────────
router.get('/roles/:roleId/salary',
  validate([
    param('roleId').isString().trim().notEmpty().isLength({ max: 100 }),
    query('country').optional().isString().trim().isLength({ max: 10 }),
    query('experienceYears').optional().isFloat({ min: 0, max: 60 }).toFloat(),
    query('currency').optional().isIn(['INR', 'USD', 'AED', 'GBP', 'EUR']),
  ]),
  ctrl.getSalaryBenchmark
);

// ── GET /roles/:roleId/education ─────────────────────────────────────────────
router.get('/roles/:roleId/education',
  validate([
    param('roleId').isString().trim().notEmpty().isLength({ max: 100 }),
    query('level').optional().isIn(VALID_EDU_LEVELS)
      .withMessage(`level must be one of: ${VALID_EDU_LEVELS.join(', ')}`),
  ]),
  ctrl.getEducationMatch
);

// ── POST /skill-gap ───────────────────────────────────────────────────────────
router.post('/skill-gap',
  validate([
    body('roleId').isString().trim().notEmpty().withMessage('roleId is required'),
    body('userSkills').isArray({ max: 100 }).withMessage('userSkills must be an array (max 100)'),
    body('userSkills.*')
      .optional()
      .custom(v => typeof v === 'string' || (typeof v === 'object' && v.name))
      .withMessage('Each skill must be a string or { name: string }'),
  ]),
  ctrl.getSkillGap
);

// ── POST /chi ─────────────────────────────────────────────────────────────────
router.post('/chi',
  validate([
    body('targetRoleId').optional().isString().trim().isLength({ max: 100 }),
    body('targetRoleName').optional().isString().trim().isLength({ max: 200 }),
    body('currentRoleId').optional().isString().trim().isLength({ max: 100 }),
    body('currentRoleName').optional().isString().trim().isLength({ max: 200 }),
    body('userSkills').optional().isArray({ max: 100 }),
    body('experienceYears').optional().isFloat({ min: 0, max: 60 }).toFloat(),
    body('educationLevel').optional().isIn(VALID_EDU_LEVELS),
    body('currentSalaryAnnual').optional().isInt({ min: 0 }).toInt(),
    body('country').optional().isString().trim().isLength({ max: 10 }),
  ]),
  ctrl.computeCHI
);

// ── POST /onboarding-insights ─────────────────────────────────────────────────
router.post('/onboarding-insights',
  validate([
    body('targetRoleId').optional().isString().trim().isLength({ max: 100 }),
    body('targetRoleName').optional().isString().trim().isLength({ max: 200 }),
    body('currentRoleId').optional().isString().trim().isLength({ max: 100 }),
    body('currentRoleName').optional().isString().trim().isLength({ max: 200 }),
    body('userSkills').optional().isArray({ max: 100 }),
    body('experienceYears').optional().isFloat({ min: 0, max: 60 }).toFloat(),
    body('educationLevel').optional().isIn(VALID_EDU_LEVELS),
    body('currentSalaryAnnual').optional().isInt({ min: 0 }).toInt(),
    body('country').optional().isString().trim().isLength({ max: 10 }),
  ]),
  ctrl.computeOnboardingInsights
);

module.exports = router;








