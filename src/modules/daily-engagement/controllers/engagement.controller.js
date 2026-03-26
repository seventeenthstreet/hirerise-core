'use strict';

/**
 * modules/daily-engagement/controllers/engagement.controller.js
 *
 * Express controllers for the Daily Engagement System.
 *
 * Endpoints handled:
 *
 *   Module 1 — Daily Career Insights Feed
 *     GET    /api/career/daily-insights            → fetch feed
 *     POST   /api/career/daily-insights/read       → mark insights as read
 *     POST   /api/career/daily-insights/generate   → manually trigger generation (dev/admin)
 *
 *   Module 2 — Career Progress Tracker
 *     GET    /api/career/progress                  → full progress report + chart data
 *     POST   /api/career/progress/record           → manually record a snapshot
 *
 *   Module 3 — Career Opportunity Alerts
 *     GET    /api/career/alerts                    → fetch alerts
 *     POST   /api/career/alerts/read               → mark alerts as read
 *
 * All handlers use asyncHandler() from utils/helpers so unhandled promise
 * rejections propagate cleanly to the Express error middleware.
 *
 * Auth: every route requires a valid Firebase Bearer token. req.user is
 * injected by auth.middleware before these handlers execute.
 */

'use strict';

const { asyncHandler } = require('../../../utils/helpers');
const logger           = require('../../../utils/logger');

const insightsService = require('../services/insights.service');
const progressService = require('../services/progress.service');
const alertsService   = require('../services/alerts.service');

// ══════════════════════════════════════════════════════════════════════════════
//  MODULE 1 — DAILY CAREER INSIGHTS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/career/daily-insights
 *
 * Returns the user's personalised insight feed, served from Redis cache
 * (10 min TTL) on warm hits.
 *
 * Query params:
 *   limit        integer  1–50  (default 20)
 *   offset       integer        (default 0)
 *   unread_only  boolean        (default false)
 *   type         string         filter by insight_type
 *
 * Response:
 * {
 *   success: true,
 *   data: {
 *     insights: [...],
 *     unread_count: 3,
 *     cached: true
 *   }
 * }
 */
const getInsightsFeed = asyncHandler(async (req, res) => {
  const userId = req.user.uid;

  const opts = {
    limit:       Math.min(parseInt(req.query.limit  || '20', 10), 50),
    offset:      parseInt(req.query.offset || '0', 10),
    unreadOnly:  req.query.unread_only === 'true',
    insightType: req.query.type || undefined,
  };

  const result = await insightsService.getInsightsFeed(userId, opts);

  res.status(200).json({
    success: true,
    data:    result,
    meta: {
      limit:        opts.limit,
      offset:       opts.offset,
      requested_at: new Date().toISOString(),
    },
  });
});

/**
 * POST /api/career/daily-insights/read
 *
 * Mark one or more insights as read.
 * Body: { ids?: string[] }  — omit ids to mark ALL as read.
 *
 * Response: { success: true, data: { updated: 4 } }
 */
const markInsightsRead = asyncHandler(async (req, res) => {
  const userId = req.user.uid;
  const ids    = Array.isArray(req.body.ids) ? req.body.ids : [];

  const result = await insightsService.markInsightsRead(userId, ids);

  res.status(200).json({
    success: true,
    data:    result,
  });
});

/**
 * POST /api/career/daily-insights/generate
 *
 * Manually trigger insight generation for the authenticated user.
 * Useful for freshening the feed after profile changes.
 * Subject to DAILY_INSIGHT_LIMIT — returns empty array if limit is reached.
 *
 * Body (optional): { role?, skills?, industry? }
 *
 * Response: { success: true, data: { insights: [...], count: 3 } }
 */
const generateInsights = asyncHandler(async (req, res) => {
  const userId      = req.user.uid;
  const userProfile = {
    role:     req.body.role     || undefined,
    skills:   req.body.skills   || undefined,
    industry: req.body.industry || undefined,
  };

  logger.info('[EngagementController] Manual insight generation', { userId });

  const insights = await insightsService.generateInsightsForUser(userId, userProfile);

  res.status(200).json({
    success: true,
    data: {
      insights,
      count: insights.length,
    },
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  MODULE 2 — CAREER PROGRESS TRACKER
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/career/progress
 *
 * Returns a structured progress report:
 *   - current scores (CHI, skills, job match)
 *   - previous scores
 *   - improvement deltas ("+7", "-2", etc.)
 *   - chart-ready history array (oldest → newest)
 *
 * Query params:
 *   days   integer  1–365  (default 90) — history window for chart data
 *
 * Example response:
 * {
 *   "success": true,
 *   "data": {
 *     "current": { "career_health_index": 72, "skills_count": 14, "job_match_score": 81 },
 *     "previous": { "career_health_index": 65, "skills_count": 12, "job_match_score": 80 },
 *     "improvement": { "career_health_index": "+7", "skills_count": "+2", "job_match_score": "+1" },
 *     "history": [...],
 *     "has_data": true,
 *     "cached": false
 *   }
 * }
 */
const getProgress = asyncHandler(async (req, res) => {
  const userId = req.user.uid;

  const result = await progressService.getProgressReport(userId);

  res.status(200).json({
    success: true,
    data:    result,
    meta: {
      requested_at: new Date().toISOString(),
    },
  });
});

/**
 * POST /api/career/progress/record
 *
 * Manually record a progress snapshot (useful for testing and forced refreshes).
 * Body (optional): { trigger_event?, chi?, skills_count?, job_match_score? }
 *
 * Response: { success: true, data: { snapshot: {...} } }
 */
const recordProgress = asyncHandler(async (req, res) => {
  const userId = req.user.uid;

  const snapshot = await progressService.recordProgress({
    userId,
    triggerEvent: req.body.trigger_event || 'manual',
    overrides: {
      chi:             req.body.chi             != null ? Number(req.body.chi)             : null,
      skills_count:    req.body.skills_count    != null ? Number(req.body.skills_count)    : null,
      job_match_score: req.body.job_match_score != null ? Number(req.body.job_match_score) : null,
    },
  });

  res.status(201).json({
    success: true,
    data: { snapshot },
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  MODULE 3 — CAREER OPPORTUNITY ALERTS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/career/alerts
 *
 * Returns the user's alerts, sorted by priority (1 = critical) then recency.
 * Served from Redis cache (10 min TTL).
 *
 * Query params:
 *   limit        integer  1–50  (default 20)
 *   offset       integer        (default 0)
 *   unread_only  boolean        (default false)
 *   type         string         filter by alert_type
 *
 * Example response:
 * {
 *   "success": true,
 *   "data": {
 *     "alerts": [
 *       {
 *         "id": "uuid",
 *         "alert_type": "job_match",
 *         "title": "New job match found",
 *         "description": "A new Operations Analyst role matches your profile with a score of 82%.",
 *         "alert_priority": 2,
 *         "is_read": false,
 *         "created_at": "2025-03-16T09:00:00Z"
 *       }
 *     ],
 *     "unread_count": 5,
 *     "cached": false
 *   }
 * }
 */
const getAlerts = asyncHandler(async (req, res) => {
  const userId = req.user.uid;

  const opts = {
    limit:      Math.min(parseInt(req.query.limit  || '20', 10), 50),
    offset:     parseInt(req.query.offset || '0', 10),
    unreadOnly: req.query.unread_only === 'true',
    alertType:  req.query.type || undefined,
  };

  const result = await alertsService.getAlertsFeed(userId, opts);

  res.status(200).json({
    success: true,
    data:    result,
    meta: {
      limit:        opts.limit,
      offset:       opts.offset,
      requested_at: new Date().toISOString(),
    },
  });
});

/**
 * POST /api/career/alerts/read
 *
 * Mark one or more alerts as read.
 * Body: { ids?: string[] }  — omit ids to mark ALL unread alerts as read.
 *
 * Response: { success: true, data: { updated: 3, unread_count: 0 } }
 */
const markAlertsRead = asyncHandler(async (req, res) => {
  const userId = req.user.uid;
  const ids    = Array.isArray(req.body.ids) ? req.body.ids : [];

  const result = await alertsService.markAlertsRead(userId, ids);

  res.status(200).json({
    success: true,
    data:    result,
  });
});

module.exports = {
  // Insights
  getInsightsFeed,
  markInsightsRead,
  generateInsights,
  // Progress
  getProgress,
  recordProgress,
  // Alerts
  getAlerts,
  markAlertsRead,
};









