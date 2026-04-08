'use strict';

/**
 * modules/daily-engagement/controllers/engagement.controller.js
 *
 * Express controllers for the Daily Engagement System.
 *
 * Supabase-ready version:
 * - Removes Firebase-specific auth assumptions
 * - Uses provider-agnostic authenticated user resolution
 * - Preserves all API responses and business behavior
 * - Improves input safety, null handling, and parsing consistency
 */

const { asyncHandler } = require('../../../utils/helpers');
const logger = require('../../../utils/logger');

const insightsService = require('../services/insights.service');
const progressService = require('../services/progress.service');
const alertsService = require('../services/alerts.service');

/**
 * Resolve authenticated user ID safely across:
 * - Supabase middleware: req.user.id
 * - Legacy transitional middleware: req.user.id
 * - Alternate auth wrappers: req.auth.userId
 *
 * Keeps migration backward compatible.
 */
function getAuthenticatedUserId(req) {
  return (
    req?.user?.id ??
    req?.user?.uid ??
    req?.auth?.userId ??
    null
  );
}

/**
 * Safe integer parser with bounds.
 */
function parseBoundedInt(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;

  return parsed;
}

/**
 * Common request metadata builder.
 */
function buildMeta(extra = {}) {
  return {
    ...extra,
    requested_at: new Date().toISOString(),
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// MODULE 1 — DAILY CAREER INSIGHTS
// ══════════════════════════════════════════════════════════════════════════════

const getInsightsFeed = asyncHandler(async (req, res) => {
  const userId = getAuthenticatedUserId(req);

  const opts = {
    limit: parseBoundedInt(req.query.limit, 20, { min: 1, max: 50 }),
    offset: parseBoundedInt(req.query.offset, 0, { min: 0 }),
    unreadOnly: req.query.unread_only === 'true',
    insightType: req.query.type || undefined,
  };

  const result = await insightsService.getInsightsFeed(userId, opts);

  res.status(200).json({
    success: true,
    data: result,
    meta: buildMeta({
      limit: opts.limit,
      offset: opts.offset,
    }),
  });
});

const markInsightsRead = asyncHandler(async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];

  const result = await insightsService.markInsightsRead(userId, ids);

  res.status(200).json({
    success: true,
    data: result,
  });
});

const generateInsights = asyncHandler(async (req, res) => {
  const userId = getAuthenticatedUserId(req);

  const userProfile = {
    role: req.body?.role || undefined,
    skills: req.body?.skills || undefined,
    industry: req.body?.industry || undefined,
  };

  logger.info('[EngagementController] Manual insight generation triggered', {
    userId,
    module: 'daily-engagement',
    action: 'generate-insights',
  });

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
// MODULE 2 — CAREER PROGRESS TRACKER
// ══════════════════════════════════════════════════════════════════════════════

const getProgress = asyncHandler(async (req, res) => {
  const userId = getAuthenticatedUserId(req);

  const result = await progressService.getProgressReport(userId);

  res.status(200).json({
    success: true,
    data: result,
    meta: buildMeta(),
  });
});

const recordProgress = asyncHandler(async (req, res) => {
  const userId = getAuthenticatedUserId(req);

  const snapshot = await progressService.recordProgress({
    userId,
    triggerEvent: req.body?.trigger_event || 'manual',
    overrides: {
      chi: req.body?.chi != null ? Number(req.body.chi) : null,
      skills_count:
        req.body?.skills_count != null
          ? Number(req.body.skills_count)
          : null,
      job_match_score:
        req.body?.job_match_score != null
          ? Number(req.body.job_match_score)
          : null,
    },
  });

  res.status(201).json({
    success: true,
    data: { snapshot },
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// MODULE 3 — CAREER OPPORTUNITY ALERTS
// ══════════════════════════════════════════════════════════════════════════════

const getAlerts = asyncHandler(async (req, res) => {
  const userId = getAuthenticatedUserId(req);

  const opts = {
    limit: parseBoundedInt(req.query.limit, 20, { min: 1, max: 50 }),
    offset: parseBoundedInt(req.query.offset, 0, { min: 0 }),
    unreadOnly: req.query.unread_only === 'true',
    alertType: req.query.type || undefined,
  };

  const result = await alertsService.getAlertsFeed(userId, opts);

  res.status(200).json({
    success: true,
    data: result,
    meta: buildMeta({
      limit: opts.limit,
      offset: opts.offset,
    }),
  });
});

const markAlertsRead = asyncHandler(async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];

  const result = await alertsService.markAlertsRead(userId, ids);

  res.status(200).json({
    success: true,
    data: result,
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