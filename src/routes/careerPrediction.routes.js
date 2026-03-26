'use strict';

/**
 * routes/careerPrediction.routes.js
 *
 * Education Intelligence — Career Success Probability Engine routes.
 *
 * Mounted in server.js alongside existing education routes:
 *   app.use(`${API_PREFIX}/education`, authenticate,
 *     require('./modules/education-intelligence/routes/careerPrediction.routes'));
 *
 * Endpoints:
 *   POST /api/v1/education/career-prediction/:studentId
 *     → Run CSPE, store + return ranked top_careers
 *
 *   GET  /api/v1/education/career-prediction/:studentId
 *     → Return previously stored predictions (no re-run)
 */

const { Router } = require('express');
const controller = require('../controllers/careerPrediction.controller');

const router = Router();

/**
 * POST /api/v1/education/career-prediction/:studentId
 *
 * Runs the Career Success Probability Engine for a student and
 * returns the top 5 ranked careers with probability scores.
 *
 * Response 200:
 * {
 *   success: true,
 *   data: {
 *     top_careers: [
 *       { career: "Software Engineer",  probability: 82 },
 *       { career: "AI / ML Engineer",   probability: 78 },
 *       { career: "Data Scientist",     probability: 74 },
 *       { career: "Systems Architect",  probability: 70 },
 *       { career: "Cybersecurity Specialist", probability: 67 }
 *     ]
 *   }
 * }
 */
router.post('/career-prediction/:studentId', controller.predictCareers);

/**
 * GET /api/v1/education/career-prediction/:studentId
 *
 * Returns previously stored career predictions.
 * Response 404 if no predictions exist.
 */
router.get('/career-prediction/:studentId', controller.getCareers);

module.exports = router;








