'use strict';

/**
 * growth.routes.js
 *
 * GET /api/v1/growth/projected
 *
 * Handler is inline here to avoid dependency on growth.controller.js
 * which requires growth.validator (missing file).
 */

const { Router }       = require('express');
const growthService    = require('../modules/growth/growth.service');

const router = Router();

router.get('/projected', async (req, res, next) => {
  try {
    const userId = req?.user?.uid ?? req?.user?.id ?? null;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const { targetRoleId, years, currentExperienceYears } = req.query;

    if (!targetRoleId) {
      return res.status(400).json({
        success: false,
        message: 'targetRoleId is required as a query parameter.',
      });
    }

    const result = await growthService.generateProjection({
      userId,
      targetRoleId,
      years:                  Math.min(parseInt(years || '5', 10), 20),
      currentExperienceYears: parseInt(currentExperienceYears || '0', 10),
    });

    return res.status(200).json({ success: true, data: result });

  } catch (err) { return next(err); }
});

module.exports = router;








