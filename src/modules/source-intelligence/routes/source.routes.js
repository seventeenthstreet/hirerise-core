'use strict';

/**
 * src/modules/source-intelligence/routes/source.routes.js
 *
 * SIM route surface. Mounted (per server-registration.snippet.js) at
 * /api/v1/admin/source-intelligence, behind `authenticate` + `requireAdmin`
 * — SIM is an internal enterprise-governance system, not student/employer
 * facing, so admin-only is the correct default. The COM-facing read
 * (`/eligible`) is intentionally on the same admin-guarded router for now;
 * once COM exists as its own service, that single endpoint can be moved
 * behind a service-to-service auth (internalToken.middleware.js) instead.
 */

const { Router } = require('express');
const controller = require('../controllers/source.controller');
const {
  createSourceValidator,
  updateSourceValidator,
  sourceIdParamValidator,
  changeStatusValidator,
  searchSourceValidator,
  recordHealthValidator,
  createRelationshipValidator,
  deleteRelationshipValidator,
} = require('../validators/source.validator');

const router = Router();

// ── Registry CRUD ───────────────────────────────────────────────
router.post('/sources', createSourceValidator, controller.createSource);
router.get('/sources', searchSourceValidator, controller.searchSources);
router.get('/sources/:sourceId', sourceIdParamValidator, controller.getSource);
router.patch('/sources/:sourceId', updateSourceValidator, controller.updateSource);
router.delete('/sources/:sourceId', sourceIdParamValidator, controller.archiveSource);

// ── Governance ───────────────────────────────────────────────────
router.post(
  '/sources/:sourceId/approval/request',
  sourceIdParamValidator,
  controller.requestApproval
);
router.post(
  '/sources/:sourceId/approval/decide',
  sourceIdParamValidator,
  controller.decideApproval
);
router.post(
  '/sources/:sourceId/status',
  changeStatusValidator,
  controller.changeStatus
);
router.get(
  '/sources/:sourceId/audit',
  sourceIdParamValidator,
  controller.getAuditTrail
);

// ── Health ───────────────────────────────────────────────────────
router.post(
  '/sources/:sourceId/health',
  recordHealthValidator,
  controller.recordHealth
);
router.get(
  '/sources/:sourceId/health/summary',
  sourceIdParamValidator,
  controller.getHealthSummary
);
router.get(
  '/sources/:sourceId/health/history',
  sourceIdParamValidator,
  controller.getHealthHistory
);

// ── Enterprise Enhancement 8: Source Relationships ────────────────
router.post(
  '/sources/:sourceId/relationships',
  createRelationshipValidator,
  controller.addRelationship
);
router.get(
  '/sources/:sourceId/relationships',
  sourceIdParamValidator,
  controller.listRelationships
);
router.delete(
  '/sources/:sourceId/relationships/:relationshipId',
  deleteRelationshipValidator,
  controller.removeRelationship
);

// ── COM integration read ─────────────────────────────────────────
router.get('/eligible', controller.listEligibleSources);

module.exports = router;
