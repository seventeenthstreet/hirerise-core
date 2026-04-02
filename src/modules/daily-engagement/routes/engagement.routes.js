'use strict';

/**
 * modules/daily-engagement/routes/engagement.routes.js
 *
 * Supabase-ready route layer.
 *
 * Improvements:
 * - removes Firebase auth assumptions
 * - shared auth-safe rate limit key resolver
 * - constants-driven validation enums
 * - stronger proxy-safe limiter config
 * - reusable validation middleware
 */

const express = require('express');
const { query, body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');

const ctrl = require('../controllers/engagement.controller');
const {
  INSIGHT_TYPES,
  ALERT_TYPES,
  PROGRESS_TRIGGERS,
} = require('../models/engagement.constants');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getAuthKey(req) {
  return (
    req?.user?.id ??
    req?.user?.uid ??
    req?.auth?.userId ??
    req.ip
  );
}

function validate(rules) {
  return [
    ...rules,
    (req, res, next) => {
      const errors = validationResult(req);

      if (!errors.isEmpty()) {
        return res.status(422).json({
          success: false,
          error: 'Validation failed',
          details: errors.array(),
        });
      }

      next();
    },
  ];
}

function createLimiter(max, message) {
  return rateLimit({
    windowMs: 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV === 'test',
    keyGenerator: getAuthKey,
    message: {
      success: false,
      error: message,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate limiters
// ─────────────────────────────────────────────────────────────────────────────

const readLimiter = createLimiter(
  60,
  'Too many requests. Max 60/min.'
);

const writeLimiter = createLimiter(
  15,
  'Too many requests. Max 15/min.'
);

// ─────────────────────────────────────────────────────────────────────────────
// Shared validation enums
// ─────────────────────────────────────────────────────────────────────────────

const paginationRules = [
  query('limit')
    .optional()
    .isInt({ min: 1, max: 50 })
    .toInt()
    .withMessage('limit must be 1–50'),

  query('offset')
    .optional()
    .isInt({ min: 0 })
    .toInt()
    .withMessage('offset must be >= 0'),
];

const insightTypeValues = Object.values(INSIGHT_TYPES);
const alertTypeValues = Object.values(ALERT_TYPES);
const triggerValues = Object.values(PROGRESS_TRIGGERS);

// ══════════════════════════════════════════════════════════════════════════════
// MODULE 1 — DAILY CAREER INSIGHTS
// ══════════════════════════════════════════════════════════════════════════════

router.get(
  '/daily-insights',
  readLimiter,
  validate([
    ...paginationRules,
    query('unread_only')
      .optional()
      .isBoolean()
      .toBoolean()
      .withMessage('unread_only must be boolean'),

    query('type')
      .optional()
      .isIn(insightTypeValues)
      .withMessage(`type must be one of: ${insightTypeValues.join(', ')}`),
  ]),
  ctrl.getInsightsFeed
);

router.post(
  '/daily-insights/read',
  writeLimiter,
  validate([
    body('ids')
      .optional()
      .isArray({ max: 100 })
      .withMessage('ids must be an array (max 100)'),

    body('ids.*')
      .optional()
      .isUUID()
      .withMessage('each id must be a valid UUID'),
  ]),
  ctrl.markInsightsRead
);

router.post(
  '/daily-insights/generate',
  writeLimiter,
  validate([
    body('role')
      .optional()
      .isString()
      .trim()
      .isLength({ max: 120 })
      .withMessage('role must be a string (max 120 chars)'),

    body('skills')
      .optional()
      .isArray({ max: 50 })
      .withMessage('skills must be an array (max 50)'),

    body('industry')
      .optional()
      .isString()
      .trim()
      .isLength({ max: 100 })
      .withMessage('industry must be a string (max 100 chars)'),
  ]),
  ctrl.generateInsights
);

// ══════════════════════════════════════════════════════════════════════════════
// MODULE 2 — CAREER PROGRESS TRACKER
// ══════════════════════════════════════════════════════════════════════════════

router.get(
  '/progress',
  readLimiter,
  validate([
    query('days')
      .optional()
      .isInt({ min: 1, max: 365 })
      .toInt()
      .withMessage('days must be 1–365'),
  ]),
  ctrl.getProgress
);

router.post(
  '/progress/record',
  writeLimiter,
  validate([
    body('trigger_event')
      .optional()
      .isIn(triggerValues)
      .withMessage('Invalid trigger_event value'),

    body('chi')
      .optional()
      .isFloat({ min: 0, max: 100 })
      .withMessage('chi must be 0–100'),

    body('skills_count')
      .optional()
      .isInt({ min: 0 })
      .withMessage('skills_count must be a non-negative integer'),

    body('job_match_score')
      .optional()
      .isFloat({ min: 0, max: 100 })
      .withMessage('job_match_score must be 0–100'),
  ]),
  ctrl.recordProgress
);

// ══════════════════════════════════════════════════════════════════════════════
// MODULE 3 — CAREER OPPORTUNITY ALERTS
// ══════════════════════════════════════════════════════════════════════════════

router.get(
  '/alerts',
  readLimiter,
  validate([
    ...paginationRules,
    query('unread_only')
      .optional()
      .isBoolean()
      .toBoolean()
      .withMessage('unread_only must be boolean'),

    query('type')
      .optional()
      .isIn(alertTypeValues)
      .withMessage(`type must be one of: ${alertTypeValues.join(', ')}`),
  ]),
  ctrl.getAlerts
);

router.post(
  '/alerts/read',
  writeLimiter,
  validate([
    body('ids')
      .optional()
      .isArray({ max: 100 })
      .withMessage('ids must be an array (max 100)'),

    body('ids.*')
      .optional()
      .isUUID()
      .withMessage('each id must be a valid UUID'),
  ]),
  ctrl.markAlertsRead
);

module.exports = router;