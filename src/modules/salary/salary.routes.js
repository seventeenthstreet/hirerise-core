'use strict';

/**
 * src/modules/salary/salary.routes.js
 *
 * Salary Data API Routes
 *
 * Supabase-aligned route layer:
 * - validation contract matches salary_data schema
 * - legacy medianSalary removed
 * - filter query validation added
 * - admin/public access behavior preserved
 * - route ordering hardened
 *
 * @module modules/salary/salary.routes
 */

const express = require('express');
const { param, body, query } = require('express-validator');

const { validate } = require('../../middleware/requestValidator');
const { requireAdmin } = require('../../middleware/auth.middleware');

const {
  getAggregated,
  getRawRecords,
  createRecord,
} = require('./salary.controller');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// Shared validation
// ─────────────────────────────────────────────────────────────────────────────
const roleIdParam = param('roleId')
  .isString()
  .trim()
  .notEmpty()
  .isLength({ max: 100 })
  .withMessage('roleId must be a non-empty string');

const aggregationQueryValidation = [
  query('location')
    .optional()
    .isString()
    .trim()
    .isLength({ max: 120 })
    .withMessage('location must be a valid string'),

  query('experienceLevel')
    .optional()
    .isIn(['Entry', 'Mid', 'Senior', 'Lead', 'Principal', 'Executive'])
    .withMessage('Invalid experienceLevel'),

  query('industry')
    .optional()
    .isString()
    .trim()
    .isLength({ max: 120 })
    .withMessage('industry must be a valid string'),
];

const salaryBodyValidation = [
  body('roleId')
    .isString()
    .trim()
    .notEmpty()
    .withMessage('roleId is required'),

  body('minSalary')
    .isFloat({ min: 0 })
    .withMessage('minSalary must be a non-negative number'),

  body('maxSalary')
    .isFloat({ min: 0 })
    .withMessage('maxSalary must be a non-negative number'),

  body('sourceType')
    .optional()
    .isIn(['ADMIN', 'CSV', 'API', 'SCRAPER'])
    .withMessage('sourceType must be one of: ADMIN, CSV, API, SCRAPER'),

  body('experienceLevel')
    .optional()
    .isIn(['Entry', 'Mid', 'Senior', 'Lead', 'Principal', 'Executive'])
    .withMessage('Invalid experienceLevel'),

  body('confidenceScore')
    .optional()
    .isFloat({ min: 0, max: 1 })
    .withMessage('confidenceScore must be between 0 and 1'),

  body('location')
    .optional()
    .isString()
    .trim()
    .isLength({ max: 120 })
    .withMessage('location must be a valid string'),

  body('industry')
    .optional()
    .isString()
    .trim()
    .isLength({ max: 120 })
    .withMessage('industry must be a valid string'),

  body('sourceName')
    .optional()
    .isString()
    .trim()
    .isLength({ max: 120 })
    .withMessage('sourceName must be a valid string'),
];

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/v1/salary-data/:roleId/records
// Raw salary records (admin only)
router.get(
  '/:roleId/records',
  requireAdmin,
  validate([roleIdParam]),
  getRawRecords
);

// GET /api/v1/salary-data/:roleId
// Aggregated salary intelligence (authenticated users)
router.get(
  '/:roleId',
  validate([roleIdParam, ...aggregationQueryValidation]),
  getAggregated
);

// POST /api/v1/salary-data
// Manual admin salary entry
router.post(
  '/',
  requireAdmin,
  validate(salaryBodyValidation),
  createRecord
);

module.exports = router;