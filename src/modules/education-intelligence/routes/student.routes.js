'use strict';

/**
 * routes/student.routes.js
 *
 * Education Intelligence API routes.
 *
 * Mount in server.js:
 *   app.use(`${API_PREFIX}/education`, authenticate, require('./modules/education-intelligence/routes/student.routes'));
 *
 * All routes inherit `authenticate` from the mount — req.user.uid is always available.
 *
 * Endpoints:
 *   POST  /api/v1/education/student      → create/update student profile
 *   POST  /api/v1/education/academics    → save subject marks
 *   POST  /api/v1/education/activities   → save extracurricular activities
 *   POST  /api/v1/education/cognitive    → save cognitive test scores
 *   GET   /api/v1/education/student/:id  → fetch full student profile
 */

const { Router } = require('express');
const controller = require('../controllers/student.controller');

const router = Router();

/**
 * POST /api/v1/education/student
 * Create or update the authenticated user's student profile.
 * First step of the education onboarding flow.
 */
router.post('/student', controller.createStudent);

/**
 * POST /api/v1/education/academics
 * Save academic subject marks. Full replace on each submit.
 * Body: { records: [{ subject, class_level, marks }] }
 */
router.post('/academics', controller.saveAcademics);

/**
 * POST /api/v1/education/activities
 * Save extracurricular activities. Full replace on each submit.
 * Body: { activities: [{ activity_name, activity_level }] }
 */
router.post('/activities', controller.saveActivities);

/**
 * POST /api/v1/education/cognitive
 * Save cognitive self-assessment scores. Marks onboarding complete.
 * Body: { analytical_score, logical_score, memory_score,
 *         communication_score, creativity_score, raw_answers? }
 */
router.post('/cognitive', controller.saveCognitive);

/**
 * GET /api/v1/education/student/:id
 * Fetch the full student profile aggregated across all collections.
 * Students may only access their own profile unless admin.
 */
router.get('/student/:id', controller.getStudentProfile);

module.exports = router;









