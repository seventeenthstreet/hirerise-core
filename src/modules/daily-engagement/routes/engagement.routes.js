'use strict';

/**
 * modules/daily-engagement/routes/engagement.routes.js
 *
 * Route definitions for the Daily Engagement System.
 * All routes are mounted under /api/career (server.js).
 *
 * Route map:
 * ┌──────────────────────────────────────────────────┬──────────────────────────────────────┐
 * │ Method + Path                                    │ Handler                              │
 * ├──────────────────────────────────────────────────┼──────────────────────────────────────┤
 * │ GET    /api/career/daily-insights                │ getInsightsFeed                      │
 * │ POST   /api/career/daily-insights/read           │ markInsightsRead                     │
 * │ POST   /api/career/daily-insights/generate       │ generateInsights                     │
 * │ GET    /api/career/progress                      │ getProgress                          │
 * │ POST   /api/career/progress/record               │ recordProgress                       │
 * │ GET    /api/career/alerts                        │ getAlerts                            │
 * │ POST   /api/career/alerts/read                   │ markAlertsRead                       │
 * └──────────────────────────────────────────────────┴──────────────────────────────────────┘
 *
 * Registration in server.js — see server.additions.daily-engagement.js.
 * Auth is applied at the mount point; all handlers receive req.user.
 */

'use strict';

const express = require('express');
const { query, body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');

const ctrl = require('../controllers/engagement.controller');

const router = express.Router();

// ─── Shared validation middleware ─────────────────────────────────────────────

function validate(rules) {
  return [
    ...rules,
    (req, res, next) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(422).json({
          success: false,
          error:   'Validation failed',
          details: errors.array(),
        });
      }
      next();
    },
  ];
}

// ─── Rate limiters ────────────────────────────────────────────────────────────

// Reads: generous — cached anyway
const readLimiter = rateLimit({
  windowMs:     60 * 1000,
  max:           60,
  keyGenerator:  (req) => req.user?.uid || req.ip,
  skip:          () => process.env.NODE_ENV === 'test',
  message: { success: false, error: 'Too many requests. Max 60/min.' },
});

// Writes / generation: stricter — involve DB writes
const writeLimiter = rateLimit({
  windowMs:     60 * 1000,
  max:           15,
  keyGenerator:  (req) => req.user?.uid || req.ip,
  skip:          () => process.env.NODE_ENV === 'test',
  message: { success: false, error: 'Too many requests. Max 15/min.' },
});

// ─── Shared query validators ──────────────────────────────────────────────────

const paginationRules = [
  query('limit')
    .optional().isInt({ min: 1, max: 50 }).toInt()
    .withMessage('limit must be 1–50'),
  query('offset')
    .optional().isInt({ min: 0 }).toInt()
    .withMessage('offset must be >= 0'),
];

const insightTypeValues = [
  'skill_demand', 'job_match', 'market_trend',
  'opportunity_signal', 'risk_alert', 'salary_update',
];

const alertTypeValues = [
  'job_match', 'skill_demand', 'career_opportunity',
  'salary_trend', 'risk_warning', 'market_shift',
];

// ══════════════════════════════════════════════════════════════════════════════
//  MODULE 1 — DAILY CAREER INSIGHTS
// ══════════════════════════════════════════════════════════════════════════════

// GET /daily-insights
router.get(
  '/daily-insights',
  readLimiter,
  validate([
    ...paginationRules,
    query('unread_only')
      .optional().isBoolean().toBoolean()
      .withMessage('unread_only must be boolean'),
    query('type')
      .optional().isIn(insightTypeValues)
      .withMessage(`type must be one of: ${insightTypeValues.join(', ')}`),
  ]),
  ctrl.getInsightsFeed
);

// POST /daily-insights/read
router.post(
  '/daily-insights/read',
  writeLimiter,
  validate([
    body('ids')
      .optional().isArray({ max: 100 })
      .withMessage('ids must be an array (max 100)'),
    body('ids.*')
      .optional().isUUID()
      .withMessage('each id must be a valid UUID'),
  ]),
  ctrl.markInsightsRead
);

// POST /daily-insights/generate
router.post(
  '/daily-insights/generate',
  writeLimiter,
  validate([
    body('role')
      .optional().isString().trim().isLength({ max: 120 })
      .withMessage('role must be a string (max 120 chars)'),
    body('skills')
      .optional().isArray({ max: 50 })
      .withMessage('skills must be an array (max 50)'),
    body('industry')
      .optional().isString().trim().isLength({ max: 100 })
      .withMessage('industry must be a string (max 100 chars)'),
  ]),
  ctrl.generateInsights
);

// ══════════════════════════════════════════════════════════════════════════════
//  MODULE 2 — CAREER PROGRESS TRACKER
// ══════════════════════════════════════════════════════════════════════════════

// GET /progress
router.get(
  '/progress',
  readLimiter,
  validate([
    query('days')
      .optional().isInt({ min: 1, max: 365 }).toInt()
      .withMessage('days must be 1–365'),
  ]),
  ctrl.getProgress
);

// POST /progress/record
router.post(
  '/progress/record',
  writeLimiter,
  validate([
    body('trigger_event')
      .optional()
      .isIn(['cv_parsed', 'skill_gap_updated', 'new_job_match', 'market_trend_updated', 'opportunity_detected', 'manual', 'scheduled'])
      .withMessage('Invalid trigger_event value'),
    body('chi')
      .optional().isFloat({ min: 0, max: 100 })
      .withMessage('chi must be 0–100'),
    body('skills_count')
      .optional().isInt({ min: 0 })
      .withMessage('skills_count must be a non-negative integer'),
    body('job_match_score')
      .optional().isFloat({ min: 0, max: 100 })
      .withMessage('job_match_score must be 0–100'),
  ]),
  ctrl.recordProgress
);

// ══════════════════════════════════════════════════════════════════════════════
//  MODULE 3 — CAREER OPPORTUNITY ALERTS
// ══════════════════════════════════════════════════════════════════════════════

// GET /alerts
router.get(
  '/alerts',
  readLimiter,
  validate([
    ...paginationRules,
    query('unread_only')
      .optional().isBoolean().toBoolean()
      .withMessage('unread_only must be boolean'),
    query('type')
      .optional().isIn(alertTypeValues)
      .withMessage(`type must be one of: ${alertTypeValues.join(', ')}`),
  ]),
  ctrl.getAlerts
);

// POST /alerts/read
router.post(
  '/alerts/read',
  writeLimiter,
  validate([
    body('ids')
      .optional().isArray({ max: 100 })
      .withMessage('ids must be an array (max 100)'),
    body('ids.*')
      .optional().isUUID()
      .withMessage('each id must be a valid UUID'),
  ]),
  ctrl.markAlertsRead
);

module.exports = router;









