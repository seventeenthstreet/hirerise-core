'use strict';

/**
 * src/modules/education-intelligence/routes/roiAnalysis.routes.js
 *
 * Education Intelligence ROI analysis routes.
 *
 * Mounted in server.js:
 * app.use(
 *   `${API_PREFIX}/education`,
 *   authenticate,
 *   require('./modules/education-intelligence/routes/roiAnalysis.routes')
 * );
 *
 * ENDPOINTS
 * POST /roi-analysis/:studentId
 *   Runs the Education ROI Engine
 *   and persists the latest ROI analysis results.
 *
 * GET /roi-analysis/:studentId
 *   Returns the latest stored ROI analysis results.
 */

const { Router } = require('express');
const controller = require('../controllers/roiAnalysis.controller');

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// ROI analysis execution
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  '/roi-analysis/:studentId',
  controller.analyzeROI
);

// ─────────────────────────────────────────────────────────────────────────────
// Cached ROI analysis retrieval
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  '/roi-analysis/:studentId',
  controller.getROI
);

module.exports = router;