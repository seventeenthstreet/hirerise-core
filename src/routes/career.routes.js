/**
 * career.routes.js — Career Path + JD Matching Routes (Enterprise Hardened)
 * All prefixed with /api/v1/career by server.js
 */

'use strict';

const express = require('express');
const { body, param, query } = require('express-validator');
const rateLimit = require('express-rate-limit');
const { validate } = require('../middleware/requestValidator');
const careerController = require('../controllers/career.controller');

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// JD Matching Rate Limiter (NLP heavy)
// ─────────────────────────────────────────────────────────────
const jdMatchingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: {
    success: false,
    error: 'JD matching rate limit exceeded. Max 10 requests per minute.',
  },
});

// ─────────────────────────────────────────────────────────────
// GET /api/v1/career/path/:currentRoleId
// ─────────────────────────────────────────────────────────────
router.get(
  '/path/:currentRoleId',
  validate([
    param('currentRoleId')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: 100 })
      .withMessage('currentRoleId is required'),

    query('types')
      .optional()
      .customSanitizer(v =>
        typeof v === 'string'
          ? v.split(',').map(t => t.trim())
          : v
      )
      .isArray({ max: 3 })
      .withMessage('types must be an array'),

    query('types.*')
      .optional()
      .isIn(['vertical', 'lateral', 'diagonal'])
      .withMessage('Invalid transition type'),

    query('maxHops')
      .optional()
      .isInt({ min: 1, max: 4 })
      .toInt()
      .withMessage('maxHops must be between 1 and 4'),
  ]),
  careerController.getCareerPaths
);

// ─────────────────────────────────────────────────────────────
// POST /api/v1/career/path-with-gap
// ─────────────────────────────────────────────────────────────
router.post(
  '/path-with-gap',
  validate([
    body('currentRoleId')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: 100 })
      .withMessage('currentRoleId is required'),

    body('userSkills')
      .isArray({ max: 100 })
      .withMessage('userSkills must be an array (max 100 items)'),

    body('userSkills.*.name')
      .isString()
      .trim()
      .notEmpty()
      .withMessage('Each user skill must have a valid name'),

    body('filters.types')
      .optional()
      .isArray({ max: 3 })
      .withMessage('filters.types must be an array'),

    body('filters.types.*')
      .optional()
      .isIn(['vertical', 'lateral', 'diagonal'])
      .withMessage('Invalid transition type'),

    body('filters.maxHops')
      .optional()
      .isInt({ min: 1, max: 4 })
      .toInt()
      .withMessage('filters.maxHops must be between 1 and 4'),
  ]),
  careerController.getCareerPathsWithGap
);

// ─────────────────────────────────────────────────────────────
// POST /api/v1/career/jd-match
// ─────────────────────────────────────────────────────────────
router.post(
  '/jd-match',
  jdMatchingLimiter,
  validate([
    body('userProfile')
      .isObject()
      .notEmpty()
      .withMessage('userProfile is required'),

    body('userProfile.skills')
      .isArray({ min: 1, max: 100 })
      .withMessage('skills array must contain 1–100 items'),

    body('userProfile.skills.*.name')
      .optional()
      .isString()
      .trim(),

    body('userProfile.totalExperience')
      .optional()
      .isFloat({ min: 0, max: 60 })
      .toFloat()
      .withMessage('totalExperience must be between 0 and 60'),

    body('userProfile.educationLevel')
      .optional()
      .isIn(['high_school', 'diploma', 'bachelors', 'masters', 'mba', 'phd'])
      .withMessage('Invalid education level'),

    body('rawJobDescription')
      .isString()
      .trim()
      .isLength({ min: 50, max: 20000 })
      .withMessage('Job description must be 50–20,000 characters'),
  ]),
  careerController.matchJobDescription
);

module.exports = router;
