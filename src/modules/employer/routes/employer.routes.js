'use strict';

/**
 * routes/employer.routes.js
 *
 * Mount in server.js:
 *
 *   app.use(
 *     `${API_PREFIX}/employer`,
 *     authenticate,
 *     require('./modules/employer/routes/employer.routes')
 *   );
 *
 * ── Endpoint Map ──────────────────────────────────────────────────────────────
 *
 *   POST   /api/v1/employer                                     → create employer org
 *   GET    /api/v1/employer/my                                  → my employer orgs
 *   GET    /api/v1/employer/:employerId                         → employer detail
 *   POST   /api/v1/employer/:employerId/roles                   → add job role (admin)
 *   GET    /api/v1/employer/:employerId/roles                   → list job roles
 *   PATCH  /api/v1/employer/:employerId/roles/:roleId           → update role (admin)
 *   DELETE /api/v1/employer/:employerId/roles/:roleId           → deactivate role (admin)
 *   GET    /api/v1/employer/:employerId/talent-pipeline         → full pipeline analytics
 *   GET    /api/v1/employer/:employerId/roles/:roleId/matches   → per-role talent insights
 */

const { Router } = require('express');
const controller = require('../controllers/employer.controller');
const { requireEmployerMember, requireEmployerAdmin } = require('../middleware/employer.middleware');

const router = Router();

router.post('/',   controller.createEmployer);
router.get('/my',  controller.getMyEmployers);

router.get('/:employerId',                requireEmployerMember, controller.getEmployer);
router.get('/:employerId/roles',          requireEmployerMember, controller.listJobRoles);
router.get('/:employerId/talent-pipeline', requireEmployerMember, controller.getTalentPipeline);

router.get(
  '/:employerId/roles/:roleId/matches',
  requireEmployerMember,
  controller.getRoleMatches
);

// Admin only
router.post(  '/:employerId/roles',           requireEmployerAdmin, controller.createJobRole);
router.patch( '/:employerId/roles/:roleId',   requireEmployerAdmin, controller.updateJobRole);
router.delete('/:employerId/roles/:roleId',   requireEmployerAdmin, controller.deactivateJobRole);

module.exports = router;









