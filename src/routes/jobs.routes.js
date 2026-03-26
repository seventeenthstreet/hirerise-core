/**
 * jobs.routes.js — Job Roles & Families Routes (Enterprise Hardened)
 * All prefixed with /api/v1/jobs
 */

'use strict';

const express = require('express');
const { param, query } = require('express-validator');
const { validate } = require('../middleware/requestValidator');
const jobController = require('../controllers/job.controller');

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// GET /api/v1/jobs/families
// ─────────────────────────────────────────────────────────────
router.get('/families', jobController.listJobFamilies);

// ─────────────────────────────────────────────────────────────
// GET /api/v1/jobs/roles
// ─────────────────────────────────────────────────────────────
router.get(
  '/roles',
  validate([
    query('familyId')
      .optional()
      .isString()
      .trim()
      .isLength({ max: 100 })
      .withMessage('familyId must be a valid string'),

    query('level')
      .optional()
      .isIn(['L1', 'L2', 'L3', 'L4', 'L5', 'L6'])
      .withMessage('Invalid level'),

    query('track')
      .optional()
      .isIn(['individual_contributor', 'management', 'specialist'])
      .withMessage('Invalid track'),

    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .toInt()
      .withMessage('limit must be between 1 and 100'),

    query('page')
      .optional()
      .isInt({ min: 1 })
      .toInt()
      .withMessage('page must be >= 1'),
  ]),
  jobController.listRoles
);

// ─────────────────────────────────────────────────────────────
// GET /api/v1/jobs/roles/:roleId
// ─────────────────────────────────────────────────────────────
router.get(
  '/roles/:roleId',
  validate([
    param('roleId')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: 100 })
      .withMessage('roleId is required'),
  ]),
  jobController.getRoleById
);

module.exports = router;









