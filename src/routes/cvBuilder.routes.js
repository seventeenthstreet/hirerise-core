'use strict';

/**
 * cvBuilder.routes.js — Supabase fixed
 */

const { Router } = require('express');
const { requirePaidPlan } = require('../middleware/requirePaidPlan.middleware');
const { aiRateLimitByPlan } = require('../middleware/aiRateLimitByPlan.middleware');
const {
  generateJobSpecificCv,
  getCvVersions
} = require('../services/cvBuilder.service');

const { supabase } = require('../config/supabase');

const router = Router();

function _userId(req) {
  return req?.user?.uid ?? req?.user?.id ?? null;
}

// ─────────────────────────────────────────────────────────
// POST — generate CV
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

    const { jobDescription, jobTitle } = req.body || {};

    const result = await generateJobSpecificCv(userId, {
      jobDescription,
      jobTitle
    });

    return res.status(200).json({
      success: true,
      data: {
        cvVersion: result
      }
    });

  } catch (err) {
    return next(err);
  }
});

// ─────────────────────────────────────────────────────────
// GET — list versions
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

    const limit = parseInt(req.query.limit || '20', 10);

    const result = await getCvVersions(userId, limit);

    return res.status(200).json({
      success: true,
      data: result
    });

  } catch (err) {
    return next(err);
  }
});

// ─────────────────────────────────────────────────────────
// GET — single CV version (FIXED)
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
      .from('user_cvs')
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
        message: 'CV version not found'
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        cvVersion: data
      }
    });

  } catch (err) {
    return next(err);
  }
});

module.exports = router;