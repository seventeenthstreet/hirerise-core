'use strict';

/**
 * src/modules/dashboard/dashboard.route.js
 *
 * GET /api/v1/dashboard
 *
 * Tier-aware dashboard endpoint.
 */

const express = require('express');
const { getDashboardData } = require('./dashboard.service');
const {
  normalizeTier,
} = require('../../middleware/requireTier.middleware');
const {
  AppError,
  ErrorCodes,
} = require('../../middleware/errorHandler');

const router = express.Router();

/**
 * GET /
 * Patch 42:
 * request-scoped dashboard hydration memoization
 */
router.get('/', async (req, res, next) => {
  try {
    const user = req.user;
    const userId = user?.uid;

    if (!userId) {
      return next(
        new AppError(
          'Unauthorized.',
          401,
          { reason: 'Missing authenticated user context.' },
          ErrorCodes.UNAUTHORIZED
        )
      );
    }

    req.context = req.context || {};

    const tier =
      user.normalizedTier ||
      normalizeTier(user.plan);

    user.normalizedTier = tier;

    if (!req.context.dashboardDataPromise) {
      req.context.dashboardDataPromise =
        getDashboardData(userId, tier);
    }

    const dashboardData =
      await req.context.dashboardDataPromise;

    return res.status(200).json({
      success: true,
      data: dashboardData,
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;