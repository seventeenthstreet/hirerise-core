'use strict';

/**
 * src/modules/dashboard/dashboard.route.js
 *
 * GET /api/v1/dashboard
 *
 * Tier-aware dashboard endpoint.
 *
 * Authentication is applied at the server mount point and this route
 * trusts `req.user` injected by the auth middleware.
 *
 * Tier source:
 * - Preferred: req.user.normalizedTier (cached by middleware)
 * - Fallback:  req.user.plan (JWT claim / auth metadata)
 *
 * Registration:
 *   app.use(
 *     `${API_PREFIX}/dashboard`,
 *     authenticate,
 *     require('./modules/dashboard/dashboard.route')
 *   );
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
 * Returns tier-aware dashboard payload for authenticated users.
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

    /**
     * Normalize once per request and cache on req.user
     * to avoid duplicate normalization work downstream.
     */
    const tier =
      user.normalizedTier ||
      normalizeTier(user.plan);

    user.normalizedTier = tier;

    const dashboardData = await getDashboardData(userId, tier);

    return res.status(200).json({
      success: true,
      data: dashboardData,
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;