'use strict';

/**
 * src/modules/university/routes/university.routes.js
 *
 * Production-ready routing layer
 * Fully Firebase-free
 * Optimized for maintainability and route safety
 */

const { Router } = require('express');
const controller = require('../controllers/university.controller');
const {
  requireUniversityMember,
  requireUniversityAdmin,
} = require('../middleware/university.middleware');

const router = Router();

// ─────────────────────────────────────────────────────────────
// Authenticated User Routes
// ─────────────────────────────────────────────────────────────

router.post('/', controller.createUniversity);
router.get('/my', controller.getMyUniversities);

// ─────────────────────────────────────────────────────────────
// University Member Routes
// ─────────────────────────────────────────────────────────────

router.get('/:universityId', requireUniversityMember, controller.getUniversity);

router
  .route('/:universityId/programs')
  .get(requireUniversityMember, controller.listPrograms)
  .post(requireUniversityAdmin, controller.createProgram);

router.get(
  '/:universityId/analytics',
  requireUniversityMember,
  controller.getAnalytics
);

router.get(
  '/:universityId/programs/:programId/matches',
  requireUniversityMember,
  controller.getProgramMatches
);

// ─────────────────────────────────────────────────────────────
// University Admin Routes
// ─────────────────────────────────────────────────────────────

router
  .route('/:universityId/programs/:programId')
  .patch(requireUniversityAdmin, controller.updateProgram)
  .delete(requireUniversityAdmin, controller.deleteProgram);

module.exports = router;