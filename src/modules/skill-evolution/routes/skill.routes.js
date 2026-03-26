'use strict';

/**
 * routes/skill.routes.js
 *
 * Mounted at: /api/v1/education/skills
 * (Auth is applied at the server.js level via authenticate middleware)
 *
 *   GET /recommendations/:studentId  — ranked skill list + roadmap
 *   GET /student-skills/:studentId   — raw per-skill rows
 */

const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/skill.controller');

router.get('/recommendations/:studentId', controller.getRecommendations);
router.get('/student-skills/:studentId',  controller.getStudentSkills);

module.exports = router;









