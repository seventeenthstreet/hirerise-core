'use strict';

/**
 * salaryData.routes.js — Salary Data API Routes
 *
 * Mounted in server.js as:
 *   app.use(`${API_PREFIX}/salary-data`, authenticate, requireAdmin, require('./modules/salary/salary.routes'));
 *
 * Public aggregation endpoint:
 *   app.use(`${API_PREFIX}/salary-data`, authenticate, require('./modules/salary/salary.routes'));
 *
 * Routes:
 *   GET  /api/v1/salary-data/:roleId            → aggregated salary intelligence
 *   GET  /api/v1/salary-data/:roleId/records    → raw salary records
 *   POST /api/v1/salary-data                    → manual admin entry (admin only)
 *
 * @module modules/salary/salary.routes
 */

const express = require('express');
const { param, body } = require('express-validator');
const { validate }    = require('../../middleware/requestValidator');
const { requireAdmin } = require('../../middleware/auth.middleware');
const {
  getAggregated,
  getRawRecords,
  createRecord,
} = require('./salary.controller');

const router = express.Router();

// ── Validation chains ─────────────────────────────────────────────────────────

const roleIdParam = param('roleId')
  .isString().trim().notEmpty().isLength({ max: 100 })
  .withMessage('roleId must be a non-empty string');

const salaryBodyValidation = [
  body('roleId').isString().trim().notEmpty()
    .withMessage('roleId is required'),

  body('minSalary').isFloat({ min: 0 })
    .withMessage('minSalary must be a non-negative number'),

  body('medianSalary').isFloat({ min: 0 })
    .withMessage('medianSalary must be a non-negative number'),

  body('maxSalary').isFloat({ min: 0 })
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
];

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/v1/salary-data/:roleId — aggregated salary intelligence (any authenticated user)
router.get('/:roleId', validate([roleIdParam]), getAggregated);

// GET /api/v1/salary-data/:roleId/records — raw records (admin only)
router.get('/:roleId/records', requireAdmin, validate([roleIdParam]), getRawRecords);

// POST /api/v1/salary-data — manual admin salary entry (admin only)
router.post('/', requireAdmin, validate(salaryBodyValidation), createRecord);

module.exports = router;








