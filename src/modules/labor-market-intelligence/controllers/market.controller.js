'use strict';

/**
 * src/modules/labor-market-intelligence/controllers/market.controller.js
 *
 * HTTP handlers for the Labor Market Intelligence API.
 *
 * GET  /api/v1/market/career-trends
 * GET  /api/v1/market/skill-demand
 * GET  /api/v1/market/salary-benchmarks
 * POST /api/v1/market/refresh
 * POST /api/v1/market/ingest
 */

const logger = require('../../../utils/logger');
const marketSvc = require('../services/marketTrend.service');
const jobCollector = require('../collectors/jobCollector.service');

const DEFAULT_BATCH_SIZE = 50;
const MAX_SKILL_LIMIT = 50;
const DEFAULT_SKILL_LIMIT = 20;

// ───────────────────────────────────────────────────────────────────────────────
// Public Controllers
// ───────────────────────────────────────────────────────────────────────────────

async function getCareerTrends(req, res, next) {
  try {
    const data = await marketSvc.getCareerTrends();

    return sendSuccess(res, {
      career_trends: data,
      count: Array.isArray(data) ? data.length : 0
    });
  } catch (error) {
    return next(error);
  }
}

async function getSkillDemand(req, res, next) {
  try {
    const limit = normalizeLimit(req.query?.limit);
    const data = await marketSvc.getSkillDemand(limit);

    return sendSuccess(res, {
      skills: data,
      count: Array.isArray(data) ? data.length : 0
    });
  } catch (error) {
    return next(error);
  }
}

async function getSalaryBenchmarks(req, res, next) {
  try {
    const data = await marketSvc.getSalaryBenchmarks();

    return sendSuccess(res, {
      benchmarks: data,
      count: Array.isArray(data) ? data.length : 0
    });
  } catch (error) {
    return next(error);
  }
}

async function runRefresh(req, res, next) {
  try {
    const forbidden = ensureAdmin(req, res, 'LMI refresh requires admin privileges.');
    if (forbidden) return forbidden;

    const batchSize = normalizeBatchSize(req.body?.batchSize);

    logger.info(
      {
        uid: req.user?.uid || null,
        batchSize
      },
      '[MarketController] Refresh triggered'
    );

    const result = await marketSvc.runRefresh({ batchSize });

    return sendSuccess(res, result);
  } catch (error) {
    return next(error);
  }
}

async function runIngest(req, res, next) {
  try {
    const forbidden = ensureAdmin(req, res, 'LMI ingest requires admin privileges.');
    if (forbidden) return forbidden;

    const batchSize = normalizeBatchSize(req.body?.batchSize);
    const source = normalizeSource(req.body?.source);

    logger.info(
      {
        uid: req.user?.uid || null,
        batchSize,
        source
      },
      '[MarketController] Ingest triggered'
    );

    const result = await jobCollector.collect({
      batchSize,
      source
    });

    return sendSuccess(res, result);
  } catch (error) {
    return next(error);
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Internal Helpers
// ───────────────────────────────────────────────────────────────────────────────

function ensureAdmin(req, res, message) {
  if (req.user?.admin === true) {
    return null;
  }

  return res.status(403).json({
    success: false,
    errorCode: 'FORBIDDEN',
    message
  });
}

function sendSuccess(res, data) {
  return res.status(200).json({
    success: true,
    data
  });
}

function normalizeBatchSize(value) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_BATCH_SIZE;
  }

  return Math.floor(parsed);
}

function normalizeLimit(value) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SKILL_LIMIT;
  }

  return Math.min(Math.floor(parsed), MAX_SKILL_LIMIT);
}

function normalizeSource(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return 'mock';
  }

  return value.trim().toLowerCase();
}

module.exports = {
  getCareerTrends,
  getSkillDemand,
  getSalaryBenchmarks,
  runRefresh,
  runIngest
};