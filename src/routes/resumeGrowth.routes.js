'use strict';

/**
 * routes/resumeGrowth.routes.js
 *
 * Resume growth analysis + latest result routes
 */

const express = require('express');
const { body, param } = require('express-validator');

const resumeGrowthController = require('../modules/resumeGrowth/resumeGrowth.controller');
const { validate } = require('../middleware/requestValidator');

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────
const MAX_ROLE_ID_LENGTH = 100;

// ─────────────────────────────────────────────────────────────
// Shared validators
// ─────────────────────────────────────────────────────────────
const roleIdBodyValidator = body('roleId')
  .isString()
  .trim()
  .notEmpty()
  .isLength({ max: MAX_ROLE_ID_LENGTH })
  .withMessage(
    `roleId must be 1-${MAX_ROLE_ID_LENGTH} characters`
  );

const roleIdParamValidator = param('roleId')
  .isString()
  .trim()
  .notEmpty()
  .isLength({ max: MAX_ROLE_ID_LENGTH })
  .withMessage(
    `roleId must be 1-${MAX_ROLE_ID_LENGTH} characters`
  );

// ─────────────────────────────────────────────────────────────
// POST /analyze
// ─────────────────────────────────────────────────────────────
router.post(
  '/analyze',
  validate([
    roleIdBodyValidator,

    body('resume')
      .isObject()
      .notEmpty()
      .withMessage('resume is required'),

    body('persist')
      .optional()
      .isBoolean()
      .withMessage('persist must be a boolean'),
  ]),
  resumeGrowthController.analyze
);

// ─────────────────────────────────────────────────────────────
// GET /latest/:roleId
// ─────────────────────────────────────────────────────────────
router.get(
  '/latest/:roleId',
  validate([roleIdParamValidator]),
  resumeGrowthController.getLatest
);

module.exports = router;