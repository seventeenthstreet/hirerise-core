'use strict';

/**
 * src/modules/analytics/controllers/analytics.controller.js
 *
 * HTTP controller for the Global Career Intelligence Dashboard.
 *
 * Wave 3 hardening upgrades:
 * - Single metric registry source of truth
 * - Deterministic service dispatch
 * - Controller/service consistency boundaries
 * - Snapshot metric normalization
 * - Future-safe cache invalidation compatibility
 * - Reduced duplicate Promise orchestration drift
 */

const logger = require('../../../utils/logger');
const analyticsService = require('../services/analytics.service');

const MAX_SNAPSHOT_DAYS = 90;
const DEFAULT_SNAPSHOT_DAYS = 30;

/**
 * Unified metric registry.
 * IMPORTANT:
 * This becomes the source of truth for:
 * - route handlers
 * - overview aggregation
 * - snapshot validation
 * - future cache namespace alignment
 */
const METRIC_HANDLERS = Object.freeze({
  career_demand: () => analyticsService.getCareerDemand(),
  skill_demand: () => analyticsService.getSkillDemand(),
  education_roi: () => analyticsService.getEducationROI(),
  career_growth: () => analyticsService.getCareerGrowth(),
  industry_trends: () => analyticsService.getIndustryTrends(),
});

const VALID_SNAPSHOT_METRICS = Object.freeze(
  Object.keys(METRIC_HANDLERS)
);

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
 * Parse snapshot days safely
 * @param {string | undefined} rawDays
 * @returns {number}
 */
function parseSnapshotDays(rawDays) {
  const parsed = Number.parseInt(
    rawDays ?? `${DEFAULT_SNAPSHOT_DAYS}`,
    10
  );

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SNAPSHOT_DAYS;
  }

  return Math.min(parsed, MAX_SNAPSHOT_DAYS);
}

/**
 * Build a metric controller from registry
 * @param {keyof typeof METRIC_HANDLERS} metric
 * @returns {Function}
 */
function createMetricController(metric) {
  return asyncHandler(`get:${metric}`, async () => {
    return METRIC_HANDLERS[metric]();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Metric Endpoints
// ─────────────────────────────────────────────────────────────────────────────

const getCareerDemand = createMetricController('career_demand');
const getSkillDemand = createMetricController('skill_demand');
const getEducationROI = createMetricController('education_roi');
const getCareerGrowth = createMetricController('career_growth');
const getIndustryTrends = createMetricController('industry_trends');

// ─────────────────────────────────────────────────────────────────────────────
// Overview Endpoint
// ─────────────────────────────────────────────────────────────────────────────

const getOverview = asyncHandler('getOverview', async () => {
  const metricEntries = await Promise.all(
    Object.entries(METRIC_HANDLERS).map(async ([metric, handler]) => {
      const result = await handler();
      return [metric, result];
    })
  );

  return Object.fromEntries(metricEntries);
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