'use strict';

/**
 * graphIntelligence.routes.js (Optimized)
 * Firebase-free + Production-ready
 */

const express = require('express');
const { param, query, body } = require('express-validator');
const { validate } = require('../../../middleware/requestValidator');
const ctrl = require('./graphIntelligence.controller');

// OPTIONAL: plug your rate limiter here
// const rateLimiter = require('../../../middleware/rateLimiter');

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// CAREER GRAPH
// ─────────────────────────────────────────────────────────────

router.get(
  '/career-graph',
  // rateLimiter.admin, // optional
  ctrl.getCareerGraph
);

// ─────────────────────────────────────────────────────────────
// ROLE DETAIL
// ─────────────────────────────────────────────────────────────

router.get(
  '/career-graph/roles/:roleId',
  validate([
    param('roleId')
      .isString().trim().notEmpty()
      .isLength({ max: 100 })
      .withMessage('Invalid roleId'),
  ]),
  ctrl.getRoleDetail
);

// ─────────────────────────────────────────────────────────────
// SKILL GRAPH
// ─────────────────────────────────────────────────────────────

router.get(
  '/skill-graph',
  // rateLimiter.admin,
  ctrl.getSkillGraph
);

// ─────────────────────────────────────────────────────────────
// SKILL DETAIL
// ─────────────────────────────────────────────────────────────

router.get(
  '/skill-graph/skills/:skillId',
  validate([
    param('skillId')
      .isString().trim().notEmpty()
      .isLength({ max: 100 })
      .withMessage('Invalid skillId'),
  ]),
  ctrl.getSkillDetail
);

// ─────────────────────────────────────────────────────────────
// SIMULATE PATH
// ─────────────────────────────────────────────────────────────

router.post(
  '/simulate-path',
  validate([
    body('current_role_id')
      .isString().trim().notEmpty()
      .withMessage('current_role_id is required'),

    body('target_role_id')
      .isString().trim().notEmpty()
      .withMessage('target_role_id is required'),

    body('max_hops')
      .optional()
      .isInt({ min: 1, max: 8 })
      .withMessage('max_hops must be between 1 and 8')
      .toInt(),
  ]),
  ctrl.simulatePath
);

// ─────────────────────────────────────────────────────────────
// ROLE SEARCH
// ─────────────────────────────────────────────────────────────

router.get(
  '/roles/search',
  validate([
    query('q')
      .optional()
      .isString()
      .trim()
      .isLength({ max: 100 })
      .withMessage('Search query too long'),

    query('limit')
      .optional()
      .isInt({ min: 1, max: 50 })
      .withMessage('Limit must be between 1 and 50')
      .toInt(),
  ]),
  ctrl.searchRoles
);

// ─────────────────────────────────────────────────────────────
// ROLE IMPACT
// ─────────────────────────────────────────────────────────────

router.get(
  '/role-impact/:roleId',
  validate([
    param('roleId')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: 100 })
      .withMessage('Invalid roleId'),
  ]),
  ctrl.getRoleImpact
);

// ─────────────────────────────────────────────────────────────

module.exports = router;