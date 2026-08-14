'use strict';

/**
 * adminUsers.routes.js — Admin User Directory Endpoints
 *
 * WP-ADMIN-04 Phase 1B (read-only); WP-ADMIN-04E adds a single role-update
 * endpoint (see "Role Management Foundation" note below).
 *
 * Mounted in server.js as:
 *   app.use(
 *     `${API_PREFIX}/admin/users`,
 *     authenticate,
 *     requireAdmin,
 *     requireElevatedSession,
 *     require('./modules/admin/users/adminUsers.routes')
 *   );
 *
 * All routes inherit authenticate + requireAdmin + requireElevatedSession
 * from the mount point (same convention as every other /admin/cms/* module).
 * WP-ADMIN-04E introduces no new authorization middleware — the PATCH route
 * below is gated by exactly the same chain as the two GET routes.
 *
 * ┌────────────────────────────────────────────────────────────────────────────┐
 * │ Method │ Path                          │ Description                       │
 * ├────────────────────────────────────────────────────────────────────────────┤
 * │ GET    │ /admin/users                  │ List users (paginated+searchable) │
 * │ GET    │ /admin/users/:id              │ Get user detail                   │
 * │ PATCH  │ /admin/users/:id/role         │ Update a user's application role  │
 * │ PATCH  │ /admin/users/:id/profile      │ Update application-level profile  │
 * │ PATCH  │ /admin/users/:id/status       │ Enable/disable the account        │
 * │ GET    │ /admin/users/:id/audit-history│ Read this user's admin_logs trail │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * WP-ADMIN-04E — Role Management Foundation: the original write endpoint.
 * `role` is validated with `isIn(usersRepo.ROLES)` — the same values
 * public.users.role's own users_role_check CHECK constraint allows (see
 * adminUsers.repository.js) — so there is exactly one place in this
 * codebase that lists the allowed roles for this endpoint.
 *
 * WP-ADMIN-COMP-04 — adds /profile, /status, and /audit-history. MFA reset,
 * password reset, a separate "lock" action, and session management remain
 * explicitly unsupported — see adminUsers.repository.js's module doc
 * comment and the WP-ADMIN-COMP-04 Completion Report for the repository
 * evidence behind each of those decisions.
 */

const express = require('express');
const { param, query, body } = require('express-validator');
const { validate } = require('../../../middleware/requestValidator');
const ctrl = require('./adminUsers.controller');
const usersRepo = require('./adminUsers.repository');

const router = express.Router();

// ── GET /admin/users ─────────────────────────────────────────────────────
router.get(
  '/',
  validate([
    query('limit')
      .optional()
      .isInt({ min: 1, max: 500 }).withMessage('limit must be 1-500'),
    query('offset')
      .optional()
      .isInt({ min: 0 }).withMessage('offset must be >= 0'),
    query('search')
      .optional()
      .isString().trim().isLength({ max: 150 }).withMessage('search must be at most 150 characters'),
  ]),
  ctrl.listUsers
);

// ── GET /admin/users/:userId ─────────────────────────────────────────────
router.get(
  '/:userId',
  validate([
    param('userId').isString().trim().notEmpty(),
  ]),
  ctrl.getUser
);

// ── PATCH /admin/users/:userId/role (WP-ADMIN-04E) ───────────────────────
router.patch(
  '/:userId/role',
  validate([
    param('userId').isString().trim().notEmpty(),
    body('role')
      .isString().trim().notEmpty()
      .isIn(usersRepo.ROLES).withMessage(`role must be one of: ${usersRepo.ROLES.join(', ')}`),
  ]),
  ctrl.updateUserRole
);

// ── PATCH /admin/users/:userId/profile (WP-ADMIN-COMP-04 — Edit Profile) ──
// Allow-listed application-level public.users fields only — see
// adminUsers.repository.js's PROFILE_FIELDS / module doc comment for why
// user_type and anything Auth-related are excluded.
const PROFILE_FIELD_VALIDATORS = [
  body('displayName').optional().isString().trim().isLength({ max: 200 }),
  body('careerGoal').optional({ nullable: true }).isString().trim().isLength({ max: 500 }),
  body('targetRole').optional({ nullable: true }).isString().trim().isLength({ max: 200 }),
  body('experienceYears').optional({ nullable: true }).isFloat({ min: 0, max: 80 }),
  body('industry').optional({ nullable: true }).isString().trim().isLength({ max: 200 }),
  body('location').optional({ nullable: true }).isString().trim().isLength({ max: 200 }),
];

router.patch(
  '/:userId/profile',
  validate([
    param('userId').isString().trim().notEmpty(),
    ...PROFILE_FIELD_VALIDATORS,
    // Reject any key not in the allow-list rather than silently dropping
    // it, so an unexpected field is a visible 400, not a quiet no-op.
    body().custom((value) => {
      const allowed = new Set(['displayName', 'careerGoal', 'targetRole', 'experienceYears', 'industry', 'location']);
      const unknown = Object.keys(value || {}).filter((k) => !allowed.has(k));
      if (unknown.length) {
        throw new Error(`Unsupported field(s): ${unknown.join(', ')}`);
      }
      if (Object.keys(value || {}).length === 0) {
        throw new Error('At least one profile field is required.');
      }
      return true;
    }),
  ]),
  ctrl.updateUserProfile
);

// ── PATCH /admin/users/:userId/status (WP-ADMIN-COMP-04 — Enable/Disable) ─
// The single account-status mutation, backed by Supabase Auth's
// banned_until (see adminUsers.repository.js#setAccountStatus). There is
// deliberately no separate "lock" action — see that method's doc comment.
router.patch(
  '/:userId/status',
  validate([
    param('userId').isString().trim().notEmpty(),
    body('action')
      .isString().trim().notEmpty()
      .isIn(['enable', 'disable']).withMessage("action must be 'enable' or 'disable'"),
  ]),
  ctrl.updateUserStatus
);

// ── GET /admin/users/:userId/audit-history (WP-ADMIN-COMP-04) ────────────
router.get(
  '/:userId/audit-history',
  validate([
    param('userId').isString().trim().notEmpty(),
    query('limit').optional().isInt({ min: 1, max: 200 }).withMessage('limit must be 1-200'),
  ]),
  ctrl.getUserAuditHistory
);

module.exports = router;
