'use strict';

/**
 * routes/university.routes.js
 *
 * Clean, production-ready routing layer
 */

const { Router } = require('express');
const controller = require('../controllers/university.controller');
const {
  requireUniversityMember,
  requireUniversityAdmin,
} = require('../middleware/university.middleware');

const router = Router();

// ─── Public (Authenticated Users) ─────────────────────

router.post('/', controller.createUniversity);
router.get('/my', controller.getMyUniversities);

// ─── University Member Routes ─────────────────────────

router.get(
  '/:universityId',
  requireUniversityMember,
  controller.getUniversity
);

router.get(
  '/:universityId/programs',
  requireUniversityMember,
  controller.listPrograms
);

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

// ─── Admin Routes ─────────────────────────────────────

router.post(
  '/:universityId/programs',
  requireUniversityAdmin,
  controller.createProgram
);

router.patch(
  '/:universityId/programs/:programId',
  requireUniversityAdmin,
  controller.updateProgram
);

router.delete(
  '/:universityId/programs/:programId',
  requireUniversityAdmin,
  controller.deleteProgram
);

module.exports = router;
