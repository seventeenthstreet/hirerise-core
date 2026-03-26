'use strict';

/**
 * controllers/analytics.controller.js
 *
 * HTTP controller for the Global Career Intelligence Dashboard.
 *
 * All endpoints are public-read (require Firebase auth but no admin role).
 * Heavy computation is cached in-memory (10 min) + Firestore (hourly snapshot).
 *
 * Routes:
 *   GET /api/v1/analytics/career-demand
 *   GET /api/v1/analytics/skill-demand
 *   GET /api/v1/analytics/education-roi
 *   GET /api/v1/analytics/career-growth
 *   GET /api/v1/analytics/industry-trends
 *   GET /api/v1/analytics/overview          ← all five in one call
 *   GET /api/v1/analytics/snapshots/:metric ← historical trend data
 */

const logger  = require('../../../utils/logger');
const service = require('../services/analytics.service');

// ─── Helper ───────────────────────────────────────────────────────────────────

function _ok(res, data) {
  return res.status(200).json({ success: true, data });
}

function _err(res, next, err, label) {
  logger.error({ err: err.message }, `[GCID] ${label} failed`);
  return next(err);
}

// ─── Career Demand Index ──────────────────────────────────────────────────────

async function getCareerDemand(req, res, next) {
  try {
    const data = await service.getCareerDemand();
    _ok(res, data);
  } catch (err) { _err(res, next, err, 'getCareerDemand'); }
}

// ─── Skill Demand Index ───────────────────────────────────────────────────────

async function getSkillDemand(req, res, next) {
  try {
    const data = await service.getSkillDemand();
    _ok(res, data);
  } catch (err) { _err(res, next, err, 'getSkillDemand'); }
}

// ─── Education ROI Index ──────────────────────────────────────────────────────

async function getEducationROI(req, res, next) {
  try {
    const data = await service.getEducationROI();
    _ok(res, data);
  } catch (err) { _err(res, next, err, 'getEducationROI'); }
}

// ─── Career Growth Forecast ───────────────────────────────────────────────────

async function getCareerGrowth(req, res, next) {
  try {
    const data = await service.getCareerGrowth();
    _ok(res, data);
  } catch (err) { _err(res, next, err, 'getCareerGrowth'); }
}

// ─── Industry Trend Analysis ──────────────────────────────────────────────────

async function getIndustryTrends(req, res, next) {
  try {
    const data = await service.getIndustryTrends();
    _ok(res, data);
  } catch (err) { _err(res, next, err, 'getIndustryTrends'); }
}

// ─── Overview — all five in one shot ─────────────────────────────────────────

async function getOverview(req, res, next) {
  try {
    const [careerDemand, skillDemand, educationROI, careerGrowth, industryTrends] =
      await Promise.all([
        service.getCareerDemand(),
        service.getSkillDemand(),
        service.getEducationROI(),
        service.getCareerGrowth(),
        service.getIndustryTrends(),
      ]);

    _ok(res, { careerDemand, skillDemand, educationROI, careerGrowth, industryTrends });
  } catch (err) { _err(res, next, err, 'getOverview'); }
}

// ─── Historical snapshots ─────────────────────────────────────────────────────

async function getSnapshots(req, res, next) {
  const { metric } = req.params;
  const days = Math.min(90, parseInt(req.query.days ?? '30', 10));

  const VALID = ['career_demand', 'skill_demand', 'education_roi', 'career_growth', 'industry_trends'];
  if (!VALID.includes(metric)) {
    return res.status(400).json({
      success: false,
      error: `Invalid metric. Must be one of: ${VALID.join(', ')}`,
    });
  }

  try {
    const snapshots = await service.getSnapshots(metric, days);
    _ok(res, { metric, snapshots });
  } catch (err) { _err(res, next, err, 'getSnapshots'); }
}

module.exports = {
  getCareerDemand,
  getSkillDemand,
  getEducationROI,
  getCareerGrowth,
  getIndustryTrends,
  getOverview,
  getSnapshots,
};









