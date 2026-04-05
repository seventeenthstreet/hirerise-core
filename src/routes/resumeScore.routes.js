'use strict';

/**
 * routes/resumeScore.routes.js
 *
 * Resume score routes
 * - GET    /me
 * - DELETE /me/cache
 */

const express = require('express');

const resumeScoreService = require('../services/resumeScore.service');
const logger = require('../utils/logger');

const router = express.Router();

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
// GET /me
// ─────────────────────────────────────────────────────────────
router.get('/me', async (req, res, next) => {
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

    const result = await resumeScoreService.calculate(userId);

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error('[ResumeScoreRoutes] Score calculation failed', {
      userId: resolveUserId(req),
      error: error.message,
    });

    return next(error);
  }
});

// ─────────────────────────────────────────────────────────────
// DELETE /me/cache
// ─────────────────────────────────────────────────────────────
router.delete('/me/cache', async (req, res, next) => {
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

    await resumeScoreService.invalidate(userId);

    return res.status(200).json({
      success: true,
      message: 'Resume score cache cleared.',
    });
  } catch (error) {
    logger.error('[ResumeScoreRoutes] Cache invalidation failed', {
      userId: resolveUserId(req),
      error: error.message,
    });

    return next(error);
  }
});

module.exports = router;