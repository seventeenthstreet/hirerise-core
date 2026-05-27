'use strict';

/**
 * core/src/modules/student-onboarding/routes/academics.routes.js
 *
 * ROUTE REGISTRATION — Academics Step
 *
 * Mounted at: /api/v1/student-onboarding/v2/step/academics  (server.js)
 *
 * Route paths are '/' because the mount point already ends in /academics.
 * Using '/academics' here would resolve to .../academics/academics → 404.
 *
 * authenticate + requireOnboardingSession are applied at the app.use() mount
 * in server.js — req.user and req.onboardingSession are guaranteed set.
 */

const { Router } = require('express');
const { getAcademics, saveAcademics }  = require('../controllers/academics.controller');
const { validateAcademicsMiddleware }  = require('../validators/academics.validator');

const router = Router();

// GET /api/v1/student-onboarding/v2/step/academics
router.get('/', getAcademics);

// POST /api/v1/student-onboarding/v2/step/academics
router.post('/', validateAcademicsMiddleware, saveAcademics);

module.exports = router;