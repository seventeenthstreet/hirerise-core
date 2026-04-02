'use strict';

/**
 * jobAnalyzer.routes.js — Supabase fixed
 */

const { Router } = require('express');
const { requirePaidPlan } = require('../middleware/requirePaidPlan.middleware');
const { aiRateLimitByPlan } = require('../middleware/aiRateLimitByPlan.middleware');
const {
  analyzeJobFit,
  getJobAnalysisHistory
} = require('../services/jobAnalyzer.service');

const { supabase } = require('../config/supabase');

const router = Router();

function _userId(req) {
  return req?.user?.uid ?? req?.user?.id ?? null;
}

// ─────────────────────────────────────────────────────────
// POST — analyze job fit
// ─────────────────────────────────────────────────────────
router.post('/', requirePaidPlan, aiRateLimitByPlan, async (req, res, next) => {
  try {
    const userId = _userId(req);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
    }

    const { jobDescription, jobUrl } = req.body || {};

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

// ─────────────────────────────────────────────────────────
// GET — history
// ─────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const userId = _userId(req);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
    }

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

// ─────────────────────────────────────────────────────────
// GET — single analysis (FIXED)
// ─────────────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const userId = _userId(req);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
    }

    const { data, error } = await supabase
      .from('job_analyses')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();

    if (error) {
      return next(error);
    }

    // 🔥 FIXED: Firestore → Supabase
    if (!data || data.userId !== userId) { // ⚠️ snake_case → user_id
      return res.status(404).json({
        success: false,
        message: 'Analysis not found'
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        analysis: data
      }
    });

  } catch (err) {
    return next(err);
  }
});

module.exports = router;