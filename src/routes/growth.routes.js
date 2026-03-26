'use strict';

/**
 * growth.routes.js
 *
 * GET /api/v1/growth/projection
 * GET /api/v1/growth/projected  (alias for backwards compatibility)
 */

const express = require('express');
const growthService = require('../modules/growth/growth.service');

const router = express.Router();

async function handleProjection(req, res, next) {
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
}

router.get('/projection', handleProjection);
router.get('/projected',  handleProjection);

module.exports = router;








