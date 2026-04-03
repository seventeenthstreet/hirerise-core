'use strict';

/**
 * src/modules/education-intelligence/routes/student.routes.js
 *
 * Education Intelligence student onboarding and profile routes.
 *
 * Mounted in server.js:
 * app.use(
 *   `${API_PREFIX}/education`,
 *   authenticate,
 *   require('./modules/education-intelligence/routes/student.routes')
 * );
 *
 * All routes inherit authentication from mount middleware.
 *
 * ENDPOINTS
 * POST /student
 *   Create or update the authenticated student's profile.
 *
 * POST /academics
 *   Atomically replace all academic subject records.
 *
 * POST /activities
 *   Atomically replace all extracurricular activities.
 *
 * POST /cognitive
 *   Save or update cognitive assessment scores.
 *
 * GET /student/:id
 *   Fetch the aggregated student onboarding profile.
 */

const { Router } = require('express');
const controller = require('../controllers/student.controller');

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Student profile
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  '/student',
  controller.createStudent
);

// ─────────────────────────────────────────────────────────────────────────────
// Academic records
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  '/academics',
  controller.saveAcademics
);

// ─────────────────────────────────────────────────────────────────────────────
// Extracurricular activities
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  '/activities',
  controller.saveActivities
);

// ─────────────────────────────────────────────────────────────────────────────
// Cognitive assessment
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  '/cognitive',
  controller.saveCognitive
);

// ─────────────────────────────────────────────────────────────────────────────
// Aggregated student profile
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  '/student/:id',
  controller.getStudentProfile
);

module.exports = router;