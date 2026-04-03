'use strict';

/**
 * src/modules/employer/routes/employer.routes.js
 *
 * Employer Integration Layer routes
 * ---------------------------------
 *
 * Mounted in server.js:
 *
 * app.use(
 *   `${API_PREFIX}/employer`,
 *   authenticate,
 *   require('./modules/employer/routes/employer.routes')
 * );
 *
 * Access model:
 * - authenticated routes only
 * - membership-scoped employer access
 * - admin-only role mutation
 */

const { Router } = require('express');

const controller = require('../controllers/employer.controller');
const {
  requireEmployerMember,
  requireEmployerAdmin,
} = require('../middleware/employer.middleware');

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Employer orgs
// ─────────────────────────────────────────────────────────────────────────────

router.post('/', controller.createEmployer);
router.get('/my', controller.getMyEmployers);

// ─────────────────────────────────────────────────────────────────────────────
// Membership-scoped routes
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  '/:employerId',
  requireEmployerMember,
  controller.getEmployer
);

router.get(
  '/:employerId/roles',
  requireEmployerMember,
  controller.listJobRoles
);

router.get(
  '/:employerId/talent-pipeline',
  requireEmployerMember,
  controller.getTalentPipeline
);

router.get(
  '/:employerId/roles/:roleId/matches',
  requireEmployerMember,
  controller.getRoleMatches
);

// ─────────────────────────────────────────────────────────────────────────────
// Admin-only routes
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  '/:employerId/roles',
  requireEmployerAdmin,
  controller.createJobRole
);

router.patch(
  '/:employerId/roles/:roleId',
  requireEmployerAdmin,
  controller.updateJobRole
);

router.delete(
  '/:employerId/roles/:roleId',
  requireEmployerAdmin,
  controller.deactivateJobRole
);

module.exports = router;