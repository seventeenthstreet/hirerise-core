'use strict';

/**
 * src/modules/student-onboarding/routes/studentOnboarding.routes.js
 *
 * Mounted at: /api/v1/student-onboarding  (see server.js registration below)
 *
 * Auth: All routes require a valid JWT — enforced by the authenticate
 * middleware applied at mount time in server.js, matching the pattern
 * used by /api/v1/onboarding and all other protected modules.
 * user_id is always derived server-side from req.user — never trusted from body.
 *
 * Phase 1 routes:
 *   POST /session           Create or resume onboarding session
 *   GET  /session           Get current session state
 *   POST /step/education    Save education level, advance to academics
 *
 * Future phase stubs (uncomment as phases are implemented):
 *   POST /step/academics
 *   POST /step/activities
 *   POST /step/cognitive
 *   POST /step/aspiration
 *   POST /submit
 *   GET  /recommendation
 */

const router = require('express').Router();
const ctrl   = require('../controllers/studentOnboarding.controller');
const { validateStep } = require('../validators/studentOnboarding.validator');
const { asyncHandler } = require('../../../utils/helpers');

// ── Session management ────────────────────────────────────────────────────────

router.post('/session', asyncHandler(ctrl.createOrResumeSession));
router.get ('/session', asyncHandler(ctrl.getSession));

// ── Step routes — Phase 1 ─────────────────────────────────────────────────────

router.post(
  '/step/education',
  validateStep('education'),
  asyncHandler(ctrl.saveEducation),
);

// ── Step routes — Phase 2 (uncomment when implemented) ───────────────────────
//
// router.post('/step/academics',  validateStep('academics'),  asyncHandler(ctrl.saveAcademics));
// router.post('/step/activities', validateStep('activities'), asyncHandler(ctrl.saveActivities));
// router.post('/step/cognitive',  validateStep('cognitive'),  asyncHandler(ctrl.saveCognitive));
// router.post('/step/aspiration', validateStep('aspiration'), asyncHandler(ctrl.saveAspiration));
//
// ── Submission & result — Phase 3 (uncomment when implemented) ───────────────
//
// router.post('/submit',          asyncHandler(ctrl.submit));
// router.get ('/recommendation',  asyncHandler(ctrl.getRecommendation));

module.exports = router;
