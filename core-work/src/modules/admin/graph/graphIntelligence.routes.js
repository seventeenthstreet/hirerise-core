'use strict';

/**
 * graphIntelligence.routes.js
 *
 * Admin Graph Intelligence API — powers the Career Intelligence Control Center.
 *
 * Mounted in server.js:
 *   app.use(`${API_PREFIX}/admin/graph-intelligence`, authenticate, requireAdmin,
 *           require('./modules/admin/graph/graphIntelligence.routes'));
 *
 * ┌────────────────────────────────────────────────────────────────────────────────────────┐
 * │ Method │ Path                                          │ Description                   │
 * ├────────────────────────────────────────────────────────────────────────────────────────┤
 * │ GET    │ /career-graph                                 │ All roles + transitions        │
 * │ GET    │ /career-graph/roles/:roleId                   │ Role detail panel              │
 * │ GET    │ /skill-graph                                  │ All skills + relationships     │
 * │ GET    │ /skill-graph/skills/:skillId                  │ Skill detail panel             │
 * │ POST   │ /simulate-path                                │ Career path simulation         │
 * │ GET    │ /roles/search                                 │ Role search (autocomplete)     │
 * │ GET    │ /role-impact/:roleId                          │ Role impact analysis           │
 * └────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * SECURITY: All routes require authenticate + requireAdmin.
 * Does NOT modify auth, Firebase rules, or Secret Manager.
 */

const express = require('express');
const { param, query, body } = require('express-validator');
const { validate } = require('../../../middleware/requestValidator');
const ctrl = require('./graphIntelligence.controller');

const router = express.Router();

// ── GET /career-graph ─────────────────────────────────────────────────────────
router.get('/career-graph', ctrl.getCareerGraph);

// ── GET /career-graph/roles/:roleId ──────────────────────────────────────────
router.get('/career-graph/roles/:roleId',
  validate([
    param('roleId').isString().trim().notEmpty().isLength({ max: 100 }),
  ]),
  ctrl.getRoleDetail
);

// ── GET /skill-graph ──────────────────────────────────────────────────────────
router.get('/skill-graph', ctrl.getSkillGraph);

// ── GET /skill-graph/skills/:skillId ─────────────────────────────────────────
router.get('/skill-graph/skills/:skillId',
  validate([
    param('skillId').isString().trim().notEmpty().isLength({ max: 100 }),
  ]),
  ctrl.getSkillDetail
);

// ── POST /simulate-path ───────────────────────────────────────────────────────
router.post('/simulate-path',
  validate([
    body('current_role_id').isString().trim().notEmpty().withMessage('current_role_id is required'),
    body('target_role_id').isString().trim().notEmpty().withMessage('target_role_id is required'),
    body('max_hops').optional().isInt({ min: 1, max: 8 }).toInt(),
  ]),
  ctrl.simulatePath
);

// ── GET /roles/search ─────────────────────────────────────────────────────────
router.get('/roles/search',
  validate([
    query('q').optional().isString().trim().isLength({ max: 100 }),
    query('limit').optional().isInt({ min: 1, max: 50 }).toInt(),
  ]),
  ctrl.searchRoles
);

// ── GET /role-impact/:roleId ──────────────────────────────────────────────────
router.get('/role-impact/:roleId',
  validate([
    param('roleId').isString().trim().notEmpty().isLength({ max: 100 }),
  ]),
  ctrl.getRoleImpact
);

module.exports = router;
