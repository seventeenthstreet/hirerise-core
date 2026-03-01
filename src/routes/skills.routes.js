/**
 * skills.routes.js — Skill Gap Engine Routes (Enterprise Hardened)
 *
 * All routes prefixed with /api/v1/skills by server.js
 */

'use strict';

const express = require('express');
const { body, param, query } = require('express-validator');
const { validate } = require('../middleware/requestValidator');
const skillsController = require('../controllers/skills.controller');

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// POST /api/v1/skills/gap-analysis
// ─────────────────────────────────────────────────────────────
router.post(
  '/gap-analysis',
  validate([
    body('targetRoleId')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: 100 })
      .withMessage('targetRoleId is required'),

    body('userSkills')
      .isArray({ min: 0, max: 200 })
      .withMessage('userSkills must be an array (max 200 skills)'),

    body('userSkills.*.name')
      .isString()
      .trim()
      .notEmpty()
      .withMessage('Each skill must have a non-empty name'),

    body('userSkills.*.proficiencyLevel')
      .optional()
      .isIn(['beginner', 'intermediate', 'advanced', 'expert'])
      .withMessage('proficiencyLevel must be: beginner, intermediate, advanced, or expert'),

    body('userSkills.*.yearsOfExperience')
      .optional()
      .isFloat({ min: 0, max: 50 })
      .toFloat()
      .withMessage('yearsOfExperience must be between 0 and 50'),

    body('includeRecommendations')
      .optional()
      .isBoolean()
      .toBoolean()
      .withMessage('includeRecommendations must be a boolean'),
  ]),
  skillsController.analyzeGap
);

// ─────────────────────────────────────────────────────────────
// POST /api/v1/skills/bulk-gap
// ─────────────────────────────────────────────────────────────
router.post(
  '/bulk-gap',
  validate([
    body('targetRoleIds')
      .isArray({ min: 1, max: 10 })
      .withMessage('targetRoleIds must be an array of 1–10 role IDs'),

    body('targetRoleIds.*')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: 100 })
      .withMessage('Each targetRoleId must be a non-empty string'),

    body('userSkills')
      .isArray({ min: 0, max: 200 })
      .withMessage('userSkills must be an array (max 200 skills)'),

    body('userSkills.*.name')
      .isString()
      .trim()
      .notEmpty()
      .withMessage('Each skill must have a non-empty name'),
  ]),
  skillsController.bulkGapAnalysis
);

// ─────────────────────────────────────────────────────────────
// GET /api/v1/skills/role/:roleId
// ─────────────────────────────────────────────────────────────
router.get(
  '/role/:roleId',
  validate([
    param('roleId')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: 100 })
      .withMessage('roleId is required'),
  ]),
  skillsController.getRoleSkills
);

// ─────────────────────────────────────────────────────────────
// GET /api/v1/skills/search
// ─────────────────────────────────────────────────────────────
router.get(
  '/search',
  validate([
    query('q')
      .isString()
      .trim()
      .isLength({ min: 2, max: 50 })
      .withMessage('Query must be between 2 and 50 characters'),

    query('category')
      .optional()
      .isIn(['technical', 'soft', 'domain', 'tool', 'language', 'framework'])
      .withMessage('Invalid skill category'),
  ]),
  skillsController.searchSkills
);

module.exports = router;
