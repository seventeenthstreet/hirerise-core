'use strict';

/**
 * cvBuilder.routes.js — Custom CV Builder (Premium Feature)
 *
 * POST /api/v1/cv-builder          — generate job-specific CV (paid users only)
 * GET  /api/v1/cv-builder          — get saved CV versions
 * GET  /api/v1/cv-builder/:id      — get single CV version
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
  generateJobSpecificCv,
  getCvVersions
} = require('../services/cvBuilder.service');
const router = Router();
function _userId(req) {
  return req?.user?.uid ?? req?.user?.id ?? null;
}

// POST /api/v1/cv-builder — generate a tailored CV version
router.post('/', requirePaidPlan, aiRateLimitByPlan, async (req, res, next) => {
  try {
    const userId = _userId(req);
    if (!userId) return res.status(401).json({
      success: false,
      message: 'Unauthorized'
    });
    const {
      jobDescription,
      jobTitle
    } = req.body || {};
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

// GET /api/v1/cv-builder — list saved CV versions
router.get('/', async (req, res, next) => {
  try {
    const userId = _userId(req);
    if (!userId) return res.status(401).json({
      success: false,
      message: 'Unauthorized'
    });
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

// GET /api/v1/cv-builder/:id — get a single CV version
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
    const snap = await supabase.from('user_cvs').select("*").eq("id", req.params.id).single();
    if (!snap.exists || snap.data()?.userId !== userId) {
      return res.status(404).json({
        success: false,
        message: 'CV version not found'
      });
    }
    return res.status(200).json({
      success: true,
      data: {
        cvVersion: snap.data()
      }
    });
  } catch (err) {
    return next(err);
  }
});
module.exports = router;