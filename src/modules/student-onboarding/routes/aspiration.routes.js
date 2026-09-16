'use strict';

/**
 * core/src/modules/student-onboarding/routes/aspiration.routes.js
 *
 * ROUTE REGISTRATION — Aspiration Step (Phase 2)
 *
 * Mounted at: /api/v1/student-onboarding/v2/step/aspiration  (server.js)
 *
 * Route paths are '/' because the mount point already ends in /aspiration.
 *
 * authenticate + requireOnboardingSession are applied at the app.use() mount
 * in server.js, matching the academics/activities/cognitive mount pattern
 * exactly — req.user and req.onboardingSession are guaranteed set before
 * these handlers run. (req.onboardingSession itself is not read by the
 * aspiration controller/service — it is required only so that an aspiration
 * save is rejected the same way academics/activities/cognitive saves are
 * when no onboarding session exists yet.)
 */

const { Router } = require('express');
const { getAspiration, saveAspiration } = require('../controllers/aspiration.controller');
const { validateSaveAspirationMiddleware } = require('../validators/aspiration.validator');

const router = Router();

// GET /api/v1/student-onboarding/v2/step/aspiration
router.get('/', getAspiration);

// POST /api/v1/student-onboarding/v2/step/aspiration
router.post('/', validateSaveAspirationMiddleware, saveAspiration);

module.exports = router;
