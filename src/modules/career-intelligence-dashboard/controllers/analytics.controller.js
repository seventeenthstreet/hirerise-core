'use strict';

/**
 * src/modules/analytics/controllers/analytics.controller.js
 *
 * HTTP controller for the Global Career Intelligence Dashboard.
 *
 * Supabase-ready, backend-agnostic controller layer:
 * - No Firebase assumptions
 * - Service-driven architecture
 * - Standardized async error propagation
 * - Safe query parsing
 * - Consistent structured logging
 *
 * Routes:
 *   GET /api/v1/analytics/career-demand
 *   GET /api/v1/analytics/skill-demand
 *   GET /api/v1/analytics/education-roi
 *   GET /api/v1/analytics/career-growth
 *   GET /api/v1/analytics/industry-trends
 *   GET /api/v1/analytics/overview
 *   GET /api/v1/analytics/snapshots/:metric
 */

const logger = require('../../../utils/logger');
const analyticsService = require('../services/analytics.service');

const VALID_SNAPSHOT_METRICS = Object.freeze([
  'career_demand',
  'skill_demand',
  'education_roi',
  'career_growth',
  'industry_trends',
]);

const MAX_SNAPSHOT_DAYS = 90;
const DEFAULT_SNAPSHOT_DAYS = 30;

/**
 * Standard success response helper
 * @param {import('express').Response} res
 * @param {*} data
 * @returns {import('express').Response}
 */
function sendSuccess(res, data) {
  return res.status(200).json({
    success: true,
    data,
  });
}

/**
 * Standard error forwarding helper
 * @param {Error} error
 * @param {string} operation
 * @param {import('express').Request} req
 * @param {import('express').NextFunction} next
 */
function handleError(error, operation, req, next) {
  logger.error(
    {
      operation,
      path: req.originalUrl,
      method: req.method,
      error: error.message,
      stack: error.stack,
    },
    `[AnalyticsController] ${operation} failed`
  );

  return next(error);
}

/**
 * Wrap async controllers for consistent error handling
 * @param {string} operation
 * @param {(req: any, res: any) => Promise<any>} handler
 * @returns {Function}
 */
function asyncHandler(operation, handler) {
  return async function wrappedController(req, res, next) {
    try {
      const data = await handler(req, res);
      return sendSuccess(res, data);
    } catch (error) {
      return handleError(error, operation, req, next);
    }
  };
}

/**
 * Safely parse snapshot days query param
 * @param {string | undefined} rawDays
 * @returns {number}
 */
function parseSnapshotDays(rawDays) {
  const parsed = Number.parseInt(rawDays ?? `${DEFAULT_SNAPSHOT_DAYS}`, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SNAPSHOT_DAYS;
  }

  return Math.min(parsed, MAX_SNAPSHOT_DAYS);
}

// ─────────────────────────────────────────────────────────────────────────────
// Metric Endpoints
// ─────────────────────────────────────────────────────────────────────────────

const getCareerDemand = asyncHandler('getCareerDemand', async () => {
  return analyticsService.getCareerDemand();
});

const getSkillDemand = asyncHandler('getSkillDemand', async () => {
  return analyticsService.getSkillDemand();
});

const getEducationROI = asyncHandler('getEducationROI', async () => {
  return analyticsService.getEducationROI();
});

const getCareerGrowth = asyncHandler('getCareerGrowth', async () => {
  return analyticsService.getCareerGrowth();
});

const getIndustryTrends = asyncHandler('getIndustryTrends', async () => {
  return analyticsService.getIndustryTrends();
});

// ─────────────────────────────────────────────────────────────────────────────
// Overview Endpoint
// ─────────────────────────────────────────────────────────────────────────────

const getOverview = asyncHandler('getOverview', async () => {
  const [
    careerDemand,
    skillDemand,
    educationROI,
    careerGrowth,
    industryTrends,
  ] = await Promise.all([
    analyticsService.getCareerDemand(),
    analyticsService.getSkillDemand(),
    analyticsService.getEducationROI(),
    analyticsService.getCareerGrowth(),
    analyticsService.getIndustryTrends(),
  ]);

  return {
    careerDemand,
    skillDemand,
    educationROI,
    careerGrowth,
    industryTrends,
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// Historical Snapshots
// ─────────────────────────────────────────────────────────────────────────────

async function getSnapshots(req, res, next) {
  const metric = req.params?.metric;
  const days = parseSnapshotDays(req.query?.days);

  if (!VALID_SNAPSHOT_METRICS.includes(metric)) {
    return res.status(400).json({
      success: false,
      error: `Invalid metric. Must be one of: ${VALID_SNAPSHOT_METRICS.join(', ')}`,
    });
  }

  try {
    const snapshots = await analyticsService.getSnapshots(metric, days);

    return sendSuccess(res, {
      metric,
      days,
      snapshots: snapshots ?? [],
    });
  } catch (error) {
    return handleError(error, 'getSnapshots', req, next);
  }
}

module.exports = Object.freeze({
  getCareerDemand,
  getSkillDemand,
  getEducationROI,
  getCareerGrowth,
  getIndustryTrends,
  getOverview,
  getSnapshots,
});