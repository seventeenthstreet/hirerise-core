'use strict';

/**
 * routes/cvBuilder.routes.js
 * CV Builder Routes — Supabase Production Hardened
 */

const { Router } = require('express');
const { body, param, query } = require('express-validator');

const { requirePaidPlan } = require('../middleware/requirePaidPlan.middleware');
const { aiRateLimitByPlan } = require('../middleware/aiRateLimitByPlan.middleware');
const { validate } = require('../middleware/requestValidator');
const {
  generateJobSpecificCv,
  getCvVersions,
} = require('../services/cvBuilder.service');
const { supabase } = require('../config/supabase');
const logger = require('../utils/logger');

const router = Router();

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────
const MAX_JOB_TITLE = 150;
const MAX_JOB_DESCRIPTION = 20000;
const DEFAULT_LIMIT = 20;
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
// Generate job-specific CV
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

    body('jobTitle')
      .optional({ nullable: true })
      .isString()
      .trim()
      .isLength({ max: MAX_JOB_TITLE })
      .withMessage(`jobTitle must not exceed ${MAX_JOB_TITLE}`),
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

      const { jobDescription, jobTitle = null } = req.body;

      logger.info('[CVBuilderRoutes] Generate request', {
        userId,
        hasJobTitle: Boolean(jobTitle),
      });

      const result = await generateJobSpecificCv(userId, {
        jobDescription,
        jobTitle,
      });

      return res.status(200).json({
        success: true,
        data: {
          cvVersion: result,
        },
      });
    } catch (error) {
      logger.error('[CVBuilderRoutes] Generate failed', {
        userId: resolveUserId(req),
        error: error.message,
      });

      return next(error);
    }
  }
);

// ─────────────────────────────────────────────────────────────
// GET /
// List CV versions
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

      const result = await getCvVersions(userId, limit);

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      logger.error('[CVBuilderRoutes] Version list failed', {
        userId: resolveUserId(req),
        error: error.message,
      });

      return next(error);
    }
  }
);

// ─────────────────────────────────────────────────────────────
// GET /:id
// Single CV version
// ─────────────────────────────────────────────────────────────
router.get(
  '/:id',
  validate([
    param('id')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: MAX_ID_LENGTH })
      .withMessage('Invalid CV version id'),
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
        .from('user_cvs')
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
          message: 'CV version not found',
        });
      }

      return res.status(200).json({
        success: true,
        data: {
          cvVersion: data,
        },
      });
    } catch (error) {
      logger.error('[CVBuilderRoutes] Single version fetch failed', {
        userId: resolveUserId(req),
        cvId: req?.params?.id ?? null,
        error: error.message,
      });

      return next(error);
    }
  }
);

module.exports = router;