'use strict';

/**
 * resumeGrowth.routes.js
 *
 * CHANGES (remediation sprint):
 *   FIX-9: Added express-validator chains for both routes using the validate()
 *           factory from requestValidator.js. Previously there was zero input
 *           validation middleware — all validation was done with ad-hoc if/else
 *           checks in the controller returning inconsistent error shapes.
 */

const express = require('express');
const { body, param } = require('express-validator');

const resumeGrowthController = require('../modules/resumeGrowth/resumeGrowth.controller');
const { validate }           = require('../middleware/requestValidator');

const router = express.Router();

// POST /api/v1/resume-growth/analyze
router.post(
  '/analyze',
  validate([
    body('roleId')
      .isString().withMessage('roleId must be a string')
      .trim()
      .notEmpty().withMessage('roleId is required')
      .isLength({ max: 100 }).withMessage('roleId must be 100 characters or fewer'),
    body('resume')
      .isObject().withMessage('resume must be an object')
      .notEmpty().withMessage('resume is required'),
    body('persist')
      .optional()
      .isBoolean().withMessage('persist must be a boolean'),
  ]),
  resumeGrowthController.analyze
);

// GET /api/v1/resume-growth/latest/:roleId
router.get(
  '/latest/:roleId',
  validate([
    param('roleId')
      .isString().withMessage('roleId must be a string')
      .trim()
      .notEmpty().withMessage('roleId is required')
      .isLength({ max: 100 }).withMessage('roleId must be 100 characters or fewer'),
  ]),
  resumeGrowthController.getLatest
);

module.exports = router;
