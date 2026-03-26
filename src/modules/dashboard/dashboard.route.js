'use strict';

/**
 * dashboard.route.js
 *
 * GET /api/v1/dashboard
 *
 * Single tier-aware dashboard endpoint.
 * Auth applied at server.js mount point — trusts req.user.
 *
 * IMPORTANT: Tier is read from req.user.plan (custom claim), NEVER from Firestore.
 * getDashboardData receives tier as a parameter.
 *
 * Registration in server.js:
 *   app.use(`${API_PREFIX}/dashboard`, authenticate, require('./modules/dashboard/dashboard.route'));
 */

const express = require('express');
const { getDashboardData } = require('./dashboard.service');
const { normalizeTier }    = require('../../middleware/requireTier.middleware');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const userId = req.user?.uid;
    if (!userId) {
      return next(new AppError('Unauthorized.', 401, {}, ErrorCodes.UNAUTHORIZED));
    }

    // Tier from custom claim only — never Firestore
    const tier = req.user.normalizedTier ?? normalizeTier(req.user.plan);
    req.user.normalizedTier = tier;

    const payload = await getDashboardData(userId, tier);

    return res.status(200).json({ success: true, data: payload });

  } catch (err) {
    return next(err);
  }
});

module.exports = router;









