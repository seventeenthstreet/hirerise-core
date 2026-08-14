'use strict';

/**
 * @file src/modules/admin/permissions/routes/permissionAdmin.routes.js
 *
 * WP-ADMIN-04F-08 — Enterprise Permission Administration API
 *
 * Mounts the administrative Registry, Assignment, and Evaluation
 * endpoints. Router-level Authentication + AdminGuard + MFA step-up are
 * NOT applied inside this file — they are applied by the caller at
 * mount time in `server.js`, exactly like every other admin route
 * module in this codebase:
 *
 *   app.use(`${API_PREFIX}/admin/permissions`,
 *     authenticate, requireAdmin, requireElevatedSession,
 *     require('./modules/admin/permissions/routes/permissionAdmin.routes'));
 *
 * On top of that shared admin gate, every route below additionally runs
 * the certified Authorization Middleware (WP-ADMIN-04F-07)
 * `requirePermission(RESOURCES.ADMINISTRATION, action)` — an
 * administrator must also hold the specific `administration:<verb>`
 * Permission Assignment to manage the Permission system itself. This
 * mirrors the same certified request flow documented in
 * `permission.middleware.js`: Authenticate -> AdminGuard ->
 * requirePermission -> Evaluation Engine -> Assignment Service ->
 * Allow/Deny -> next().
 */

const express = require('express');

const { validate } = require('../../../../middleware/requestValidator');
const { asyncHandler } = require('../../../../utils/helpers');
const { requirePermission } = require('../../../../domain/permission/middleware/permission.middleware');
const { RESOURCES, CORE_ACTIONS } = require('../../../../domain/permission/permission.constants');

const { permissionRegistryController } = require('../controllers/permissionRegistry.controller');
const { permissionAssignmentController } = require('../controllers/permissionAssignment.controller');
const { permissionEvaluationController } = require('../controllers/permissionEvaluation.controller');
const { permissionGovernanceController } = require('../controllers/permissionGovernance.controller');
const { permissionHistoryController } = require('../controllers/permissionHistory.controller');
const validators = require('../validators/permissionAdmin.validators');

const router = express.Router();

const canView = requirePermission(RESOURCES.ADMINISTRATION, CORE_ACTIONS.VIEW);
const canCreate = requirePermission(RESOURCES.ADMINISTRATION, CORE_ACTIONS.CREATE);
const canDelete = requirePermission(RESOURCES.ADMINISTRATION, CORE_ACTIONS.DELETE);
// WP-ADMIN-05C — a Governance lifecycle transition mutates the Permission
// Registry entry itself; UPDATE is this codebase's existing verb for
// that (see CORE_ACTIONS), reusing the same requirePermission() gate
// every other mutation route on this router already uses. No new
// authorization model is introduced.
const canUpdate = requirePermission(RESOURCES.ADMINISTRATION, CORE_ACTIONS.UPDATE);

// ─────────────────────────────────────────────
// Registry — GET /permissions/registry/...
// ─────────────────────────────────────────────

router.get(
  '/registry',
  canView,
  validate(validators.listPermissions),
  asyncHandler(permissionRegistryController.listPermissions)
);

router.get(
  '/registry/resource/:resource',
  canView,
  validate(validators.findByResource),
  asyncHandler(permissionRegistryController.findByResource)
);

router.get(
  '/registry/action/:action',
  canView,
  validate(validators.findByAction),
  asyncHandler(permissionRegistryController.findByAction)
);

router.get(
  '/registry/category/:category',
  canView,
  validate(validators.findByCategory),
  asyncHandler(permissionRegistryController.findByCategory)
);

router.get(
  '/registry/identity/:identity',
  canView,
  validate(validators.getPermissionByIdentity),
  asyncHandler(permissionRegistryController.getPermissionByIdentity)
);

router.get(
  '/registry/:id',
  canView,
  validate(validators.getPermissionById),
  asyncHandler(permissionRegistryController.getPermissionById)
);

// ─────────────────────────────────────────────
// Assignment — /permissions/assignments/...
// ─────────────────────────────────────────────

router.post(
  '/assignments',
  canCreate,
  validate(validators.assignmentMutationBody),
  asyncHandler(permissionAssignmentController.assignPermission)
);

router.delete(
  '/assignments',
  canDelete,
  validate(validators.assignmentMutationBody),
  asyncHandler(permissionAssignmentController.revokePermission)
);

router.get(
  '/assignments/check',
  canView,
  validate(validators.checkAssignmentQuery),
  asyncHandler(permissionAssignmentController.checkAssignment)
);

router.get(
  '/assignments',
  canView,
  validate(validators.listAssignmentsQuery),
  asyncHandler(permissionAssignmentController.listAssignments)
);

router.get(
  '/assignments/principal/:principalId',
  canView,
  validate(validators.assignmentsForPrincipal),
  asyncHandler(permissionAssignmentController.getAssignmentsForPrincipal)
);

// ─────────────────────────────────────────────
// Governance — POST /permissions/:id/<transition>
// WP-ADMIN-05C — Enterprise Permission Governance Integration
// ─────────────────────────────────────────────

router.post(
  '/:id/approve',
  canUpdate,
  validate(validators.governanceTransition),
  asyncHandler(permissionGovernanceController.approve)
);

router.post(
  '/:id/publish',
  canUpdate,
  validate(validators.governanceTransition),
  asyncHandler(permissionGovernanceController.publish)
);

router.post(
  '/:id/adopt',
  canUpdate,
  validate(validators.governanceTransition),
  asyncHandler(permissionGovernanceController.adopt)
);

router.post(
  '/:id/deprecate',
  canUpdate,
  validate(validators.governanceTransition),
  asyncHandler(permissionGovernanceController.deprecate)
);

router.post(
  '/:id/retire',
  canUpdate,
  validate(validators.governanceTransition),
  asyncHandler(permissionGovernanceController.retire)
);

// ─────────────────────────────────────────────
// History — GET /permissions/history, GET /permissions/:id/history
// WP-ADMIN-05D — Enterprise Permission Audit & Governance History
//
// Read-only. Reuses `canView` — the same read gate as every Registry
// Discovery route above — never `canUpdate`; History exposes existing
// audit records, it performs no mutation. The static `/history` route
// is declared before `/:id/history` (mirroring `/registry/identity/:identity`
// before `/registry/:id` above) purely for this file's own ordering
// convention; the two do not actually collide (different segment counts).
// ─────────────────────────────────────────────

router.get(
  '/history',
  canView,
  validate(validators.historyQuery),
  asyncHandler(permissionHistoryController.listHistory)
);

router.get(
  '/:id/history',
  canView,
  validate(validators.permissionHistoryById),
  asyncHandler(permissionHistoryController.getHistoryForPermission)
);

// ─────────────────────────────────────────────
// Evaluation — POST /permissions/evaluate
// ─────────────────────────────────────────────

router.post(
  '/evaluate',
  canView,
  validate(validators.evaluate),
  asyncHandler(permissionEvaluationController.evaluate)
);

module.exports = router;
