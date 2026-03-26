'use strict';

/**
 * routes/analysis.routes.js
 *
 * Education Intelligence — stream analysis routes.
 *
 * Mount in server.js (after the existing education student routes mount):
 *   app.use(`${API_PREFIX}/education`, authenticate, require('./modules/education-intelligence/routes/analysis.routes'));
 *
 * All routes inherit `authenticate` from the mount point.
 *
 * Endpoints:
 *   POST  /api/v1/education/analyze/:studentId  → run full AI pipeline
 *   GET   /api/v1/education/analyze/:studentId  → return cached result
 */

const { Router }     = require('express');
const controller     = require('../controllers/analysis.controller');

const router = Router();

/**
 * POST /api/v1/education/analyze/:studentId
 *
 * Runs the four-engine AI pipeline:
 *   AcademicTrendEngine → CognitiveProfileEngine → ActivityAnalyzerEngine → StreamIntelligenceEngine
 *
 * Saves results to edu_stream_scores and returns the recommendation.
 *
 * Query params:
 *   ?requireComplete=false  — allow partial analysis (useful for testing)
 *
 * Response 200:
 * {
 *   success: true,
 *   data: {
 *     recommended_stream:  "engineering",
 *     recommended_label:   "Computer Science",
 *     confidence:          84,
 *     alternative_stream:  "commerce",
 *     alternative_label:   "Commerce",
 *     stream_scores: { engineering: 84, medical: 34, commerce: 72, humanities: 55 },
 *     rationale:           "Strong Mathematics (88%)...",
 *     engine_version:      "1.0.0",
 *   }
 * }
 */
router.post('/analyze/:studentId', controller.analyzeStudentProfile);

/**
 * GET /api/v1/education/analyze/:studentId
 *
 * Returns the most recently cached stream analysis result.
 * Does NOT re-run the pipeline.
 *
 * Response 404 if no analysis has been run yet.
 */
router.get('/analyze/:studentId', controller.getAnalysisResult);

module.exports = router;








