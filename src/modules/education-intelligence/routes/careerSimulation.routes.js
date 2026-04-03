'use strict';

/**
 * src/modules/education-intelligence/routes/careerSimulation.routes.js
 *
 * Education Intelligence career simulation routes.
 *
 * Mounted in server.js:
 * app.use(
 *   `${API_PREFIX}/education`,
 *   authenticate,
 *   require('./modules/education-intelligence/routes/careerSimulation.routes')
 * );
 *
 * ENDPOINTS
 * POST /career-simulation/:studentId
 *   Runs the Career Digital Twin simulation engine
 *   and persists the latest simulation results.
 *
 * GET /career-simulation/:studentId
 *   Returns the latest stored career simulations.
 */

const { Router } = require('express');
const controller = require('../controllers/careerSimulation.controller');

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Career simulation execution
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  '/career-simulation/:studentId',
  controller.simulateCareers
);

// ─────────────────────────────────────────────────────────────────────────────
// Cached career simulations
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  '/career-simulation/:studentId',
  controller.getSimulations
);

module.exports = router;