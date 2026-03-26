'use strict';

/**
 * controllers/market.controller.js
 *
 * HTTP handlers for the Labor Market Intelligence API.
 *
 * GET  /api/v1/market/career-trends      — demand scores per career
 * GET  /api/v1/market/skill-demand       — trending skills
 * GET  /api/v1/market/salary-benchmarks  — salary projections per career
 * POST /api/v1/market/refresh            — trigger full LMI refresh (admin)
 * POST /api/v1/market/ingest             — trigger job collection only (admin)
 */

const logger      = require('../../../utils/logger');
const marketSvc   = require('../services/marketTrend.service');

// ─── GET /career-trends ───────────────────────────────────────────────────────

async function getCareerTrends(req, res, next) {
  try {
    const data = await marketSvc.getCareerTrends();
    return res.status(200).json({
      success: true,
      data:    { career_trends: data, count: data.length },
    });
  } catch (err) { next(err); }
}

// ─── GET /skill-demand ────────────────────────────────────────────────────────

async function getSkillDemand(req, res, next) {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const data  = await marketSvc.getSkillDemand(limit);
    return res.status(200).json({
      success: true,
      data:    { skills: data, count: data.length },
    });
  } catch (err) { next(err); }
}

// ─── GET /salary-benchmarks ───────────────────────────────────────────────────

async function getSalaryBenchmarks(req, res, next) {
  try {
    const data = await marketSvc.getSalaryBenchmarks();
    return res.status(200).json({
      success: true,
      data:    { benchmarks: data, count: data.length },
    });
  } catch (err) { next(err); }
}

// ─── POST /refresh (admin only) ───────────────────────────────────────────────

async function runRefresh(req, res, next) {
  try {
    if (!req.user?.admin) {
      return res.status(403).json({
        success: false, errorCode: 'FORBIDDEN',
        message: 'LMI refresh requires admin privileges.',
      });
    }
    const batchSize = Number(req.body?.batchSize) || 50;
    logger.info({ uid: req.user.uid, batchSize }, '[MarketController] Refresh triggered');
    const result = await marketSvc.runRefresh({ batchSize });
    return res.status(200).json({ success: true, data: result });
  } catch (err) { next(err); }
}

// ─── POST /ingest (admin only) ────────────────────────────────────────────────

async function runIngest(req, res, next) {
  try {
    if (!req.user?.admin) {
      return res.status(403).json({
        success: false, errorCode: 'FORBIDDEN',
        message: 'LMI ingest requires admin privileges.',
      });
    }
    const jobCollector = require('../collectors/jobCollector.service');
    const batchSize    = Number(req.body?.batchSize) || 50;
    const source       = req.body?.source || 'mock';
    const result       = await jobCollector.collect({ batchSize, source });
    return res.status(200).json({ success: true, data: result });
  } catch (err) { next(err); }
}

module.exports = { getCareerTrends, getSkillDemand, getSalaryBenchmarks, runRefresh, runIngest };









