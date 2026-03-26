'use strict';

/**
 * skillGraph.routes.js — Skill Graph Intelligence API
 *
 * Mounted in server.js:
 *   app.use(`${API_PREFIX}/skill-graph`, authenticate, require('./modules/skillGraph/skillGraph.routes'));
 *
 * ┌────────────────────────────────────────────────────────────────────────────────┐
 * │ Method │ Path                                     │ Description                │
 * ├────────────────────────────────────────────────────────────────────────────────┤
 * │ GET    │ /skills                                  │ List all skills            │
 * │ GET    │ /skills/search?q=                        │ Search skills              │
 * │ GET    │ /skills/:skillId                         │ Skill detail + graph edges │
 * │ GET    │ /skills/:skillId/prerequisites           │ Prerequisite tree          │
 * │ GET    │ /skills/:skillId/learning-path           │ Path to acquire skill      │
 * │ GET    │ /roles/:roleId/skills                    │ Role → skill map           │
 * │ POST   │ /gap                                     │ Skill gap detection        │
 * │ POST   │ /learning-paths                          │ Learning paths for role    │
 * │ POST   │ /intelligence                            │ Full skill intelligence    │
 * │ POST   │ /chi-score                               │ CHI skill dimension score  │
 * └────────────────────────────────────────────────────────────────────────────────┘
 */

const express = require('express');
const { body, param, query } = require('express-validator');
const { validate } = require('../../middleware/requestValidator');
const ctrl        = require('./skillGraph.controller');

const router = express.Router();

const VALID_CATEGORIES = ['technical', 'soft', 'domain', 'tool'];
const VALID_REL_TYPES  = ['prerequisite', 'advanced', 'related', 'complementary'];

// ── GET /skills ───────────────────────────────────────────────────────────────
router.get('/skills',
  validate([
    query('category').optional().isIn(VALID_CATEGORIES),
    query('limit').optional().isInt({ min: 1, max: 500 }).toInt(),
  ]),
  ctrl.listSkills
);

// ── GET /skills/search ────────────────────────────────────────────────────────
router.get('/skills/search',
  validate([
    query('q').isString().trim().isLength({ min: 2, max: 100 }),
    query('category').optional().isIn(VALID_CATEGORIES),
    query('limit').optional().isInt({ min: 1, max: 50 }).toInt(),
  ]),
  ctrl.searchSkills
);

// ── GET /skills/:skillId ──────────────────────────────────────────────────────
router.get('/skills/:skillId',
  validate([
    param('skillId').isString().trim().notEmpty().isLength({ max: 100 }),
  ]),
  ctrl.getSkill
);

// ── GET /skills/:skillId/prerequisites ───────────────────────────────────────
router.get('/skills/:skillId/prerequisites',
  validate([
    param('skillId').isString().trim().notEmpty().isLength({ max: 100 }),
    query('deep').optional().isIn(['true', 'false']),
  ]),
  ctrl.getPrerequisites
);

// ── GET /skills/:skillId/learning-path ───────────────────────────────────────
router.get('/skills/:skillId/learning-path',
  validate([
    param('skillId').isString().trim().notEmpty().isLength({ max: 100 }),
    query('userSkills').optional().isString().trim().isLength({ max: 2000 }),
  ]),
  ctrl.getLearningPath
);

// ── GET /roles/:roleId/skills ─────────────────────────────────────────────────
router.get('/roles/:roleId/skills',
  validate([
    param('roleId').isString().trim().notEmpty().isLength({ max: 100 }),
  ]),
  ctrl.getRoleSkillMap
);

// ── POST /gap ────────────────────────────────────────────────────────────────
router.post('/gap',
  validate([
    body('roleId').isString().trim().notEmpty().isLength({ max: 100 }),
    body('userSkills').isArray({ max: 150 }),
    body('userSkills.*').optional()
      .custom(v => typeof v === 'string' || (typeof v === 'object' && v.name))
      .withMessage('Each skill must be a string or { name: string }'),
  ]),
  ctrl.detectGap
);

// ── POST /learning-paths ──────────────────────────────────────────────────────
router.post('/learning-paths',
  validate([
    body('roleId').isString().trim().notEmpty().isLength({ max: 100 }),
    body('userSkills').isArray({ max: 150 }),
  ]),
  ctrl.generateLearningPaths
);

// ── POST /intelligence ────────────────────────────────────────────────────────
router.post('/intelligence',
  validate([
    body('roleId').isString().trim().notEmpty().isLength({ max: 100 }),
    body('userSkills').isArray({ max: 150 }),
    body('chiWeight').optional().isFloat({ min: 0, max: 1 }).toFloat(),
    body('country').optional().isString().trim().isLength({ max: 10 }),
  ]),
  ctrl.getSkillIntelligence
);

// ── POST /chi-score ───────────────────────────────────────────────────────────
router.post('/chi-score',
  validate([
    body('roleId').isString().trim().notEmpty().isLength({ max: 100 }),
    body('userSkills').isArray({ max: 150 }),
    body('weight').optional().isFloat({ min: 0, max: 1 }).toFloat(),
  ]),
  ctrl.computeChiScore
);

module.exports = router;








