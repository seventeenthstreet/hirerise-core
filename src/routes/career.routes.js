'use strict';

/**
 * routes/career.routes.js
 * Career Path + JD Matching Routes (Supabase Production Hardened)
 *
 * Mounted at:
 * /api/v1/career
 */

const express = require('express');
const { body, param, query } = require('express-validator');
const rateLimit = require('express-rate-limit');

const { validate } = require('../middleware/requestValidator');
const careerController = require('../controllers/career.controller');

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────
const TRANSITION_TYPES = Object.freeze([
  'vertical',
  'lateral',
  'diagonal',
]);

const EDUCATION_LEVELS = Object.freeze([
  'high_school',
  'diploma',
  'bachelors',
  'masters',
  'mba',
  'phd',
]);

const MAX_ROLE_ID_LENGTH = 100;
const MAX_SKILLS = 100;
const MAX_TYPES = 3;
const MAX_HOPS = 4;
const MAX_TOTAL_EXPERIENCE = 60;
const MIN_JD_LENGTH = 50;
const MAX_JD_LENGTH = 20000;

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function splitCsvToArray(value) {
  if (typeof value !== 'string') return value;

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

// ─────────────────────────────────────────────────────────────
// JD Matching Rate Limiter
// NLP-heavy route protection
// ─────────────────────────────────────────────────────────────
const jdMatchingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'JD matching rate limit exceeded. Max 10 requests per minute.',
    },
  },
});

// ─────────────────────────────────────────────────────────────
// GET /career/path/:currentRoleId
// ─────────────────────────────────────────────────────────────
router.get(
  '/path/:currentRoleId',
  validate([
    param('currentRoleId')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: MAX_ROLE_ID_LENGTH })
      .withMessage('currentRoleId is required'),

    query('types')
      .optional()
      .customSanitizer(splitCsvToArray)
      .isArray({ max: MAX_TYPES })
      .withMessage(`types must be an array with max ${MAX_TYPES} values`),

    query('types.*')
      .optional()
      .isIn(TRANSITION_TYPES)
      .withMessage('Invalid transition type'),

    query('maxHops')
      .optional()
      .isInt({ min: 1, max: MAX_HOPS })
      .toInt()
      .withMessage(`maxHops must be between 1 and ${MAX_HOPS}`),
  ]),
  careerController.getCareerPaths
);

// ─────────────────────────────────────────────────────────────
// POST /career/path-with-gap
// ─────────────────────────────────────────────────────────────
router.post(
  '/path-with-gap',
  validate([
    body('currentRoleId')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: MAX_ROLE_ID_LENGTH })
      .withMessage('currentRoleId is required'),

    body('userSkills')
      .isArray({ max: MAX_SKILLS })
      .withMessage(`userSkills must be an array (max ${MAX_SKILLS} items)`),

    body('userSkills.*.name')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: 120 })
      .withMessage('Each user skill must have a valid name'),

    body('filters.types')
      .optional()
      .isArray({ max: MAX_TYPES })
      .withMessage(`filters.types must be an array (max ${MAX_TYPES})`),

    body('filters.types.*')
      .optional()
      .isIn(TRANSITION_TYPES)
      .withMessage('Invalid transition type'),

    body('filters.maxHops')
      .optional()
      .isInt({ min: 1, max: MAX_HOPS })
      .toInt()
      .withMessage(`filters.maxHops must be between 1 and ${MAX_HOPS}`),
  ]),
  careerController.getCareerPathsWithGap
);

// ─────────────────────────────────────────────────────────────
// POST /career/jd-match
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
      .isArray({ min: 1, max: MAX_SKILLS })
      .withMessage(`skills array must contain 1–${MAX_SKILLS} items`),

    body('userProfile.skills.*.name')
      .optional()
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: 120 })
      .withMessage('Each skill name must be valid'),

    body('userProfile.totalExperience')
      .optional()
      .isFloat({ min: 0, max: MAX_TOTAL_EXPERIENCE })
      .toFloat()
      .withMessage(
        `totalExperience must be between 0 and ${MAX_TOTAL_EXPERIENCE}`
      ),

    body('userProfile.educationLevel')
      .optional()
      .isIn(EDUCATION_LEVELS)
      .withMessage('Invalid education level'),

    body('rawJobDescription')
      .isString()
      .trim()
      .isLength({
        min: MIN_JD_LENGTH,
        max: MAX_JD_LENGTH,
      })
      .withMessage(
        `Job description must be ${MIN_JD_LENGTH}–${MAX_JD_LENGTH} characters`
      ),
  ]),
  careerController.matchJobDescription
);

module.exports = router;