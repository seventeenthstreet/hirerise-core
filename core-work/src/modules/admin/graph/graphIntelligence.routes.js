'use strict';

/**
 * graphIntelligence.routes.js
 * Production-ready Express routes
 * Supabase-native architecture compatible
 *
 * Notes:
 * - No Firebase dependencies remain
 * - Validation centralized for maintainability
 * - Route behavior fully preserved
 * - Drop-in compatible with existing controller layer
 */

const express = require('express');
const { param, query, body } = require('express-validator');
const { validate } = require('../../../middleware/requestValidator');
const ctrl = require('./graphIntelligence.controller');

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// SHARED VALIDATORS
// ─────────────────────────────────────────────────────────────

const roleIdValidator = param('roleId')
  .isString()
  .trim()
  .notEmpty()
  .isLength({ max: 100 })
  .withMessage('Invalid roleId');

const skillIdValidator = param('skillId')
  .isString()
  .trim()
  .notEmpty()
  .isLength({ max: 100 })
  .withMessage('Invalid skillId');

const searchQueryValidator = query('q')
  .optional()
  .isString()
  .trim()
  .isLength({ max: 100 })
  .withMessage('Search query too long');

const limitValidator = query('limit')
  .optional()
  .isInt({ min: 1, max: 50 })
  .withMessage('Limit must be between 1 and 50')
  .toInt();

const currentRoleValidator = body('current_role_id')
  .isString()
  .trim()
  .notEmpty()
  .withMessage('current_role_id is required');

const targetRoleValidator = body('target_role_id')
  .isString()
  .trim()
  .notEmpty()
  .withMessage('target_role_id is required');

const maxHopsValidator = body('max_hops')
  .optional()
  .isInt({ min: 1, max: 8 })
  .withMessage('max_hops must be between 1 and 8')
  .toInt();

// ─────────────────────────────────────────────────────────────
// CAREER GRAPH
// ─────────────────────────────────────────────────────────────

router.get('/career-graph', ctrl.getCareerGraph);

// ─────────────────────────────────────────────────────────────
// ROLE DETAIL
// ─────────────────────────────────────────────────────────────

router.get(
  '/career-graph/roles/:roleId',
  validate([roleIdValidator]),
  ctrl.getRoleDetail
);

// ─────────────────────────────────────────────────────────────
// SKILL GRAPH
// ─────────────────────────────────────────────────────────────

router.get('/skill-graph', ctrl.getSkillGraph);

// ─────────────────────────────────────────────────────────────
// SKILL DETAIL
// ─────────────────────────────────────────────────────────────

router.get(
  '/skill-graph/skills/:skillId',
  validate([skillIdValidator]),
  ctrl.getSkillDetail
);

// ─────────────────────────────────────────────────────────────
// SIMULATE PATH
// ─────────────────────────────────────────────────────────────

router.post(
  '/simulate-path',
  validate([
    currentRoleValidator,
    targetRoleValidator,
    maxHopsValidator,
  ]),
  ctrl.simulatePath
);

// ─────────────────────────────────────────────────────────────
// ROLE SEARCH
// ─────────────────────────────────────────────────────────────

router.get(
  '/roles/search',
  validate([searchQueryValidator, limitValidator]),
  ctrl.searchRoles
);

// ─────────────────────────────────────────────────────────────
// ROLE IMPACT
// ─────────────────────────────────────────────────────────────

router.get(
  '/role-impact/:roleId',
  validate([roleIdValidator]),
  ctrl.getRoleImpact
);

// ─────────────────────────────────────────────────────────────

module.exports = router;