'use strict';

/**
 * growth.routes.js
 *
 * GET /api/v1/growth/projected
 *
 * Production-safe route for growth projections.
 * Supabase auth middleware should attach req.user.id.
 */

const { Router } = require('express');
const growthService = require('./growth.service');
const logger = require('../../utils/logger');

const router = Router();

/**
 * Safely parse bounded integer query values.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function parseBoundedInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);

  if (Number.isNaN(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
}

router.get('/projected', async (req, res, next) => {
  try {
    /**
     * Supabase auth middleware should standardize req.user.id.
     * Keep uid fallback during migration compatibility.
     */
    const userId =
      req?.user?.id ??
      req?.user?.uid ??
      null;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
    }

    const {
      targetRoleId,
      years,
      currentExperienceYears
    } = req.query;

    if (!targetRoleId) {
      return res.status(400).json({
        success: false,
        message: 'targetRoleId is required as a query parameter.'
      });
    }

    const projectionYears = parseBoundedInt(years, 5, 1, 20);
    const experienceYears = parseBoundedInt(
      currentExperienceYears,
      0,
      0,
      50
    );

    const result = await growthService.generateProjection({
      userId,
      targetRoleId,
      years: projectionYears,
      currentExperienceYears: experienceYears
    });

    return res.status(200).json({
      success: true,
      data: result
    });

  } catch (error) {
    logger.error('Growth projection route failed', {
      module: 'growth.routes',
      route: 'GET /projected',
      userId: req?.user?.id ?? null,
      error: error.message
    });

    return next(error);
  }
});

module.exports = router;