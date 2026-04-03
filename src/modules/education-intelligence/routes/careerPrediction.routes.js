'use strict';

/**
 * src/modules/education-intelligence/routes/careerPrediction.routes.js
 *
 * Education Intelligence career prediction routes.
 *
 * Mounted in server.js:
 * app.use(
 *   `${API_PREFIX}/education`,
 *   authenticate,
 *   require('./modules/education-intelligence/routes/careerPrediction.routes')
 * );
 *
 * ENDPOINTS
 * POST /career-prediction/:studentId
 *   Runs the Career Success Probability Engine (CSPE)
 *   and persists ranked career predictions.
 *
 * GET /career-prediction/:studentId
 *   Returns the latest stored career predictions.
 */

const { Router } = require('express');
const controller = require('../controllers/careerPrediction.controller');

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Career prediction execution
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  '/career-prediction/:studentId',
  controller.predictCareers
);

// ─────────────────────────────────────────────────────────────────────────────
// Cached career predictions
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  '/career-prediction/:studentId',
  controller.getCareers
);

module.exports = router;