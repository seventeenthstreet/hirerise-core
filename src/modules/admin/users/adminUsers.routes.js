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
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ Method │ Path                     │ Description                     │
 * ├──────────────────────────────────────────────────────────────────────┤
 * │ GET    │ /admin/users             │ List users (paginated+searchable)│
 * │ GET    │ /admin/users/:id         │ Get user detail                  │
 * │ PATCH  │ /admin/users/:id/role    │ Update a user's application role │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * WP-ADMIN-04E — Role Management Foundation: the one write endpoint this
 * WP is scoped to. `role` is validated with `isIn(usersRepo.ROLES)` — the
 * same values public.users.role's own users_role_check CHECK constraint
 * allows (see adminUsers.repository.js) — so there is exactly one place in
 * this codebase that lists the allowed roles for this endpoint. Account
 * status, MFA, password, session, and audit-history management remain
 * explicitly out of scope (see WP-ADMIN-04E "Out of Scope").
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

module.exports = router;
