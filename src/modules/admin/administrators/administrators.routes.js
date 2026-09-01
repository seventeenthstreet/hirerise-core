'use strict';

/**
 * administrators.routes.js — Enterprise Administrator Management Endpoints
 *
 * WP-ADMIN-05A / WP-ADMIN-05A-R1
 *
 * Mounted in server.js as:
 *   app.use(
 *     `${API_PREFIX}/admin/administrators`,
 *     authenticate,
 *     requireAdmin,
 *     requireElevatedSession,
 *     require('./modules/admin/administrators/administrators.routes')
 *   );
 *
 * POLICY UPDATE (supersedes WP-ADMIN-05A-R1 for Suspend/Reactivate only):
 * the authoritative policy is now MASTER_ADMIN > ADMIN — ADMIN is delegated
 * administrative authority and MUST NOT be able to suspend or reactivate
 * administrator principals. requireAdmin's own certified admin_principals
 * verification (status='active' + session TTL, requireAdmin.middleware.js)
 * remains the baseline gate for every route below.
 *
 * requireMasterAdmin is applied at the ROUTE level, on every route the
 * approved policy designates MASTER_ADMIN-exclusive: Grant, Suspend,
 * Reactivate, and Revoke. List and Details require only requireAdmin.
 *
 * ┌────────────────────────────────────────────────────────────────────────┐
 * │ Method │ Path                              │ Authorization             │
 * ├────────────────────────────────────────────────────────────────────────┤
 * │ GET    │ /admin/administrators             │ requireAdmin              │
 * │ GET    │ /admin/administrators/:uid         │ requireAdmin              │
 * │ POST   │ /admin/administrators/:uid/grant   │ requireAdmin + requireMasterAdmin │
 * │ POST   │ /admin/administrators/:uid/suspend │ requireAdmin + requireMasterAdmin │
 * │ POST   │ /admin/administrators/:uid/reactivate │ requireAdmin + requireMasterAdmin │
 * │ POST   │ /admin/administrators/:uid/revoke  │ requireAdmin + requireMasterAdmin │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * Every mutating route below is a direct, unmodified pass-through to
 * ../repository/adminPrincipal.repository.js via administrators.service.js.
 * `role` is validated against admin_principals' own
 * `admin_principals_role_check` CHECK constraint values (see
 * supabase/migrations/000_initial_schema.sql) — the same single-source-of-
 * truth convention adminUsers.routes.js uses for usersRepo.ROLES.
 */

const express = require('express');
const { param, query, body } = require('express-validator');
const { validate } = require('../../../middleware/requestValidator');
const { requireMasterAdmin } = require('../../../middleware/requireMasterAdmin.middleware');
const ctrl = require('./administrators.controller');
const { STATES } = require('../../../domain/admin/lifecycle/adminLifecycle.states');

// Matches admin_principals_role_check exactly (000_initial_schema.sql).
// This table's roles are a DELIBERATELY smaller set than
// adminUsers.repository.ROLES (public.users.role) — Administrator
// Principals are never granted the application-facing 'user'/'contributor'
// roles.
const PRINCIPAL_ROLES = Object.freeze(['admin', 'super_admin', 'MASTER_ADMIN']);

const router = express.Router();

// ── GET /admin/administrators ────────────────────────────────────────────
router.get(
  '/',
  validate([
    query('limit')
      .optional()
      .isInt({ min: 1, max: 200 }).withMessage('limit must be 1-200'),
    query('offset')
      .optional()
      .isInt({ min: 0 }).withMessage('offset must be >= 0'),
    query('search')
      .optional()
      .isString().trim().isLength({ max: 150 }).withMessage('search must be at most 150 characters'),
    query('status')
      .optional()
      .isIn(Object.values(STATES)).withMessage(`status must be one of: ${Object.values(STATES).join(', ')}`),
  ]),
  ctrl.listAdministrators
);

// ── GET /admin/administrators/:uid ───────────────────────────────────────
router.get(
  '/:uid',
  validate([
    param('uid').isString().trim().notEmpty(),
  ]),
  ctrl.getAdministrator
);

// ── POST /admin/administrators/:uid/grant ────────────────────────────────
// WP-ADMIN-05A-R1: MASTER_ADMIN-only, per approved policy and per the
// certified repository's own grant() docstring ("MASTER_ADMIN only").
router.post(
  '/:uid/grant',
  requireMasterAdmin,
  validate([
    param('uid').isString().trim().notEmpty(),
    body('role')
      .isString().trim().notEmpty()
      .isIn(PRINCIPAL_ROLES).withMessage(`role must be one of: ${PRINCIPAL_ROLES.join(', ')}`),
  ]),
  ctrl.grantAdministrator
);

// ── POST /admin/administrators/:uid/suspend ──────────────────────────────
// MASTER_ADMIN-only, per the Master Admin > Admin authoritative policy:
// ADMIN is delegated administrative authority and MUST NOT be able to
// suspend administrator principals. Mirrors grant/revoke's placement above.
router.post(
  '/:uid/suspend',
  requireMasterAdmin,
  validate([
    param('uid').isString().trim().notEmpty(),
    body('reason')
      .optional({ nullable: true })
      .isString().trim().isLength({ max: 500 }).withMessage('reason must be at most 500 characters'),
  ]),
  ctrl.suspendAdministrator
);

// ── POST /admin/administrators/:uid/reactivate ───────────────────────────
// MASTER_ADMIN-only, per the Master Admin > Admin authoritative policy:
// ADMIN is delegated administrative authority and MUST NOT be able to
// reactivate administrator principals. Mirrors grant/revoke's placement above.
router.post(
  '/:uid/reactivate',
  requireMasterAdmin,
  validate([
    param('uid').isString().trim().notEmpty(),
  ]),
  ctrl.reactivateAdministrator
);

// ── POST /admin/administrators/:uid/revoke ───────────────────────────────
// WP-ADMIN-05A-R1: MASTER_ADMIN-only, per approved policy.
router.post(
  '/:uid/revoke',
  requireMasterAdmin,
  validate([
    param('uid').isString().trim().notEmpty(),
  ]),
  ctrl.revokeAdministrator
);

module.exports = router;
