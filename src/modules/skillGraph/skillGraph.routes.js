'use strict';

const express = require('express');
const { body, param, query } = require('express-validator');
const { validate } = require('../../middleware/requestValidator');
const ctrl = require('./skillGraph.controller');

const router = express.Router();

const VALID_CATEGORIES = Object.freeze([
  'technical',
  'soft',
  'domain',
  'tool',
]);

const BOOLEAN_STRING = Object.freeze(['true', 'false']);
const MAX_ID_LENGTH = 100;
const MAX_USER_SKILLS = 150;

const skillIdValidator = param('skillId')
  .isString()
  .trim()
  .notEmpty()
  .isLength({ max: MAX_ID_LENGTH });

const roleIdValidator = validator =>
  validator('roleId')
    .isString()
    .trim()
    .notEmpty()
    .isLength({ max: MAX_ID_LENGTH });

// ── GET /skills ───────────────────────────────────────────────────────────────
router.get(
  '/skills',
  validate([
    query('category').optional().isIn(VALID_CATEGORIES),
    query('limit').optional().isInt({ min: 1, max: 500 }).toInt(),
  ]),
  ctrl.listSkills
);

// ── GET /skills/search ────────────────────────────────────────────────────────
router.get(
  '/skills/search',
  validate([
    query('q').isString().trim().isLength({ min: 2, max: 100 }),
    query('category').optional().isIn(VALID_CATEGORIES),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  ]),
  ctrl.searchSkills
);

// ── GET /skills/:skillId ──────────────────────────────────────────────────────
router.get(
  '/skills/:skillId',
  validate([skillIdValidator]),
  ctrl.getSkill
);

// ── GET /skills/:skillId/prerequisites ───────────────────────────────────────
router.get(
  '/skills/:skillId/prerequisites',
  validate([
    skillIdValidator,
    query('deep').optional().isIn(BOOLEAN_STRING),
  ]),
  ctrl.getPrerequisites
);

// ── GET /skills/:skillId/learning-path ───────────────────────────────────────
router.get(
  '/skills/:skillId/learning-path',
  validate([
    skillIdValidator,
    query('userSkills')
      .optional()
      .isString()
      .trim()
      .isLength({ max: 2000 }),
  ]),
  ctrl.getLearningPath
);

// ── GET /roles/:roleId/skills ─────────────────────────────────────────────────
router.get(
  '/roles/:roleId/skills',
  validate([roleIdValidator(param)]),
  ctrl.getRoleSkillMap
);

// ── POST /gap ────────────────────────────────────────────────────────────────
router.post(
  '/gap',
  validate([
    roleIdValidator(body),
    body('userSkills').optional().isArray({ max: MAX_USER_SKILLS }),
    body('userSkills.*')
      .optional()
      .custom(
        value =>
          typeof value === 'string' ||
          (typeof value === 'object' &&
            (value.name || value.skill_id || value.skill_name))
      )
      .withMessage(
        'Each skill must be a string or object with name/skill_id/skill_name'
      ),
  ]),
  ctrl.detectGap
);

// ── POST /learning-paths ──────────────────────────────────────────────────────
router.post(
  '/learning-paths',
  validate([
    roleIdValidator(body),
    body('userSkills').optional().isArray({ max: MAX_USER_SKILLS }),
  ]),
  ctrl.generateLearningPaths
);

// ── POST /intelligence ────────────────────────────────────────────────────────
router.post(
  '/intelligence',
  validate([
    roleIdValidator(body),
    body('userSkills').optional().isArray({ max: MAX_USER_SKILLS }),
    body('chiWeight').optional().isFloat({ min: 0, max: 1 }).toFloat(),
    body('country').optional().isString().trim().isLength({ max: 10 }),
  ]),
  ctrl.getSkillIntelligence
);

// ── POST /chi-score ───────────────────────────────────────────────────────────
router.post(
  '/chi-score',
  validate([
    roleIdValidator(body),
    body('userSkills').optional().isArray({ max: MAX_USER_SKILLS }),
    body('weight').optional().isFloat({ min: 0, max: 1 }).toFloat(),
  ]),
  ctrl.computeChiScore
);

module.exports = router;