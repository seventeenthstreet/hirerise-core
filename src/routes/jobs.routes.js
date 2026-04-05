'use strict';

/**
 * routes/jobs.routes.js
 * Job Roles & Families Routes
 *
 * Mounted at:
 * /api/v1/jobs
 */

const express = require('express');
const { param, query } = require('express-validator');

const { validate } = require('../middleware/requestValidator');
const jobController = require('../controllers/job.controller');

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────
const MAX_ID_LENGTH = 100;
const MAX_LIMIT = 100;

const JOB_LEVELS = Object.freeze([
  'L1',
  'L2',
  'L3',
  'L4',
  'L5',
  'L6',
]);

const JOB_TRACKS = Object.freeze([
  'individual_contributor',
  'management',
  'specialist',
]);

// ─────────────────────────────────────────────────────────────
// GET /families
// ─────────────────────────────────────────────────────────────
router.get('/families', jobController.listJobFamilies);

// ─────────────────────────────────────────────────────────────
// GET /roles
// ─────────────────────────────────────────────────────────────
router.get(
  '/roles',
  validate([
    query('familyId')
      .optional()
      .isString()
      .trim()
      .isLength({ max: MAX_ID_LENGTH })
      .withMessage('familyId must be a valid string'),

    query('level')
      .optional()
      .isIn(JOB_LEVELS)
      .withMessage('Invalid level'),

    query('track')
      .optional()
      .isIn(JOB_TRACKS)
      .withMessage('Invalid track'),

    query('limit')
      .optional()
      .isInt({ min: 1, max: MAX_LIMIT })
      .toInt()
      .withMessage(`limit must be between 1 and ${MAX_LIMIT}`),

    query('page')
      .optional()
      .isInt({ min: 1 })
      .toInt()
      .withMessage('page must be >= 1'),
  ]),
  jobController.listRoles
);

// ─────────────────────────────────────────────────────────────
// GET /roles/:roleId
// ─────────────────────────────────────────────────────────────
router.get(
  '/roles/:roleId',
  validate([
    param('roleId')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: MAX_ID_LENGTH })
      .withMessage('roleId is required'),
  ]),
  jobController.getRoleById
);

module.exports = router;