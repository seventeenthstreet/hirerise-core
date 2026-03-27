'use strict';

/**
 * jobAnalyzer.routes.js — Job Fit Analyzer (Premium Feature)
 *
 * POST /api/v1/job-analyses        — analyze job fit (paid users only)
 * GET  /api/v1/job-analyses        — get analysis history
 * GET  /api/v1/job-analyses/:id    — get single analysis
 *
 * authenticate is applied at server.js mount point.
 */
const {
  Router
} = require('express');
const {
  requirePaidPlan
} = require('../middleware/requirePaidPlan.middleware');
const {
  aiRateLimitByPlan
} = require('../middleware/aiRateLimitByPlan.middleware');
const {
  analyzeJobFit,
  getJobAnalysisHistory
} = require('../services/jobAnalyzer.service');
const router = Router();
function _userId(req) {
  return req?.user?.uid ?? req?.user?.id ?? null;
}

// POST /api/v1/job-analyses — run job fit analysis
router.post('/', requirePaidPlan, aiRateLimitByPlan, async (req, res, next) => {
  try {
    const userId = _userId(req);
    if (!userId) return res.status(401).json({
      success: false,
      message: 'Unauthorized'
    });
    const {
      jobDescription,
      jobUrl
    } = req.body || {};
    const result = await analyzeJobFit(userId, {
      jobDescription,
      jobUrl
    });
    return res.status(200).json({
      success: true,
      data: {
        analysis: result
      }
    });
  } catch (err) {
    return next(err);
  }
});

// GET /api/v1/job-analyses — get analysis history
router.get('/', async (req, res, next) => {
  try {
    const userId = _userId(req);
    if (!userId) return res.status(401).json({
      success: false,
      message: 'Unauthorized'
    });
    const limit = parseInt(req.query.limit || '10', 10);
    const result = await getJobAnalysisHistory(userId, limit);
    return res.status(200).json({
      success: true,
      data: result
    });
  } catch (err) {
    return next(err);
  }
});

// GET /api/v1/job-analyses/:id — get single analysis
router.get('/:id', async (req, res, next) => {
  try {
    const userId = _userId(req);
    if (!userId) return res.status(401).json({
      success: false,
      message: 'Unauthorized'
    });
    const {
      db
    } = require('../config/supabase');
    const snap = await supabase.from('job_analyses').select("*").eq("id", req.params.id).single();
    if (!snap.exists || snap.data()?.userId !== userId) {
      return res.status(404).json({
        success: false,
        message: 'Analysis not found'
      });
    }
    return res.status(200).json({
      success: true,
      data: {
        analysis: snap.data()
      }
    });
  } catch (err) {
    return next(err);
  }
});
module.exports = router;