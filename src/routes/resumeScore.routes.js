'use strict';

/**
 * resumeScore.routes.js
 *
 * CHANGES (remediation sprint):
 *   FIX-2: IDOR fix — removed /:userId param. Route is now GET /me.
 *           userId is derived from req.user.uid (set by authenticate middleware).
 *           Any authenticated user previously could read ANY user's score by
 *           substituting their target's UID in the path.
 */

const express = require('express');
const router  = express.Router();

const resumeScoreService = require('../services/resumeScore.service');

// GET /api/v1/resume-scores/me
router.get('/me', async (req, res, next) => {
  try {
    // FIX-2: Use req.user.uid — never trust a userId from the URL
    const userId = req.user.uid;

    const result = await resumeScoreService.calculate(userId);

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/resume-scores/me/cache — cache invalidation endpoint
router.delete('/me/cache', async (req, res, next) => {
  try {
    const userId = req.user.uid;
    await resumeScoreService.invalidate(userId);
    res.status(200).json({ success: true, message: 'Resume score cache cleared.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;









