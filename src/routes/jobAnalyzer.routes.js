'use strict';

/**
 * routes/jobAnalyzer.routes.js
 * Job Analyzer Routes — Supabase Production Hardened
 */

const { Router } = require('express');
const { body, param, query } = require('express-validator');

const { requirePaidPlan } = require('../middleware/requirePaidPlan.middleware');
const { aiRateLimitByPlan } = require('../middleware/aiRateLimitByPlan.middleware');
const { validate } = require('../middleware/requestValidator');
const {
  analyzeJobFit,
  getJobAnalysisHistory,
} = require('../services/jobAnalyzer.service');
const { supabase } = require('../config/supabase');
const logger = require('../utils/logger');

const router = Router();

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────
const MAX_JOB_DESCRIPTION = 20000;
const MAX_JOB_URL = 2000;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
const MAX_ID_LENGTH = 100;

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function resolveUserId(req) {
  return (
    req?.user?.id ||
    req?.user?.uid ||
    req?.auth?.userId ||
    req?.user?.user_id ||
    null
  );
}

// ─────────────────────────────────────────────────────────────
// POST /
// Analyze job fit
// ─────────────────────────────────────────────────────────────
router.post(
  '/',
  requirePaidPlan,
  aiRateLimitByPlan,
  validate([
    body('jobDescription')
      .isString()
      .trim()
      .isLength({ min: 20, max: MAX_JOB_DESCRIPTION })
      .withMessage(
        `jobDescription must be 20-${MAX_JOB_DESCRIPTION} characters`
      ),

    body('jobUrl')
      .optional({ nullable: true })
      .isString()
      .trim()
      .isLength({ max: MAX_JOB_URL })
      .withMessage(`jobUrl must not exceed ${MAX_JOB_URL}`),
  ]),
  async (req, res, next) => {
    try {
      const userId = resolveUserId(req);

      if (!userId) {
        return res.status(401).json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication required.',
          },
        });
      }

      const {
        jobDescription,
        jobUrl = null,
      } = req.body;

      logger.info('[JobAnalyzerRoutes] Analyze request', {
        userId,
        hasJobUrl: Boolean(jobUrl),
      });

      const result = await analyzeJobFit(userId, {
        jobDescription,
        jobUrl,
      });

      return res.status(200).json({
        success: true,
        data: {
          analysis: result,
        },
      });
    } catch (error) {
      logger.error('[JobAnalyzerRoutes] Analyze failed', {
        userId: resolveUserId(req),
        error: error.message,
      });

      return next(error);
    }
  }
);

// ─────────────────────────────────────────────────────────────
// GET /
// History
// ─────────────────────────────────────────────────────────────
router.get(
  '/',
  validate([
    query('limit')
      .optional()
      .isInt({ min: 1, max: MAX_LIMIT })
      .toInt()
      .withMessage(`limit must be 1-${MAX_LIMIT}`),
  ]),
  async (req, res, next) => {
    try {
      const userId = resolveUserId(req);

      if (!userId) {
        return res.status(401).json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication required.',
          },
        });
      }

      const limit = req.query.limit ?? DEFAULT_LIMIT;

      const result = await getJobAnalysisHistory(userId, limit);

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      logger.error('[JobAnalyzerRoutes] History fetch failed', {
        userId: resolveUserId(req),
        error: error.message,
      });

      return next(error);
    }
  }
);

// ─────────────────────────────────────────────────────────────
// GET /:id
// Single analysis
// ─────────────────────────────────────────────────────────────
router.get(
  '/:id',
  validate([
    param('id')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: MAX_ID_LENGTH })
      .withMessage('Invalid analysis id'),
  ]),
  async (req, res, next) => {
    try {
      const userId = resolveUserId(req);

      if (!userId) {
        return res.status(401).json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication required.',
          },
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

      // ✅ FIXED: correct Supabase snake_case ownership
      if (!data || data.user_id !== userId) {
        return res.status(404).json({
          success: false,
          message: 'Analysis not found',
        });
      }

      return res.status(200).json({
        success: true,
        data: {
          analysis: data,
        },
      });
    } catch (error) {
      logger.error('[JobAnalyzerRoutes] Single analysis fetch failed', {
        userId: resolveUserId(req),
        analysisId: req?.params?.id ?? null,
        error: error.message,
      });

      return next(error);
    }
  }
);

module.exports = router;