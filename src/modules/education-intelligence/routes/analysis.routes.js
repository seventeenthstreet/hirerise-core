'use strict';

/**
 * src/modules/education-intelligence/routes/analysis.routes.js
 *
 * Education Intelligence analysis routes.
 *
 * Mounted in server.js:
 * app.use(
 *   `${API_PREFIX}/education`,
 *   authenticate,
 *   require('./modules/education-intelligence/routes/analysis.routes')
 * );
 *
 * All routes inherit authentication from mount middleware.
 *
 * ENDPOINTS
 * POST /analyze/:studentId
 *   Runs the full Education Intelligence pipeline:
 *   - Academic Trend
 *   - Cognitive Profile
 *   - Activity Analysis
 *   - Stream Intelligence
 *   - Career Success
 *   - Education ROI
 *   - Career Digital Twin
 *   - Skill Evolution
 *
 * GET /analyze/:studentId
 *   Returns the latest persisted analysis snapshot.
 */

const { Router } = require('express');
const controller = require('../controllers/analysis.controller');

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Analysis execution
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  '/analyze/:studentId',
  controller.analyzeStudentProfile
);

// ─────────────────────────────────────────────────────────────────────────────
// Cached analysis retrieval
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  '/analyze/:studentId',
  controller.getAnalysisResult
);

module.exports = router;