'use strict';

/**
 * src/modules/skill-evolution/routes/skill.routes.js
 *
 * Mounted at:
 *   /api/v1/education/skills
 *
 * Auth is applied globally at server level.
 *
 * Routes:
 *   GET /recommendations/:studentId
 *     → ranked skill list + roadmap
 *
 *   GET /student-skills/:studentId
 *     → raw per-skill proficiency rows
 */

const { Router } = require('express');
const skillController = require('../controllers/skill.controller');

const router = Router();

/**
 * Skill recommendation endpoints
 */
router.get(
  '/recommendations/:studentId',
  skillController.getRecommendations
);

router.get(
  '/student-skills/:studentId',
  skillController.getStudentSkills
);

module.exports = router;