'use strict';

/**
 * adminUsers.controller.js — HTTP handlers for the Admin User Directory
 *
 * WP-ADMIN-04 Phase 1B (read-only); write handler added by WP-ADMIN-04E.
 *
 * Response envelope matches the existing HireRise convention (see
 * adminCmsSkills.controller.js):
 *   { success: true, data: {...} }
 *   { success: false, error: { code, message }, details: {...} }
 *
 * @module modules/admin/users/adminUsers.controller
 */

const { asyncHandler } = require('../../../utils/helpers');
const usersService = require('./adminUsers.service');
const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');
const logger = require('../../../utils/logger');

// ── GET /api/v1/admin/users ──────────────────────────────────────────────

const listUsers = asyncHandler(async (req, res) => {
  const { limit, offset, search } = req.query;

  const result = await usersService.listUsers({
    limit: limit ? Math.min(parseInt(limit, 10), 500) : 50,
    offset: offset ? Math.max(parseInt(offset, 10), 0) : 0,
    search: search || undefined,
  });

  logger.info('[AdminUsers] Listed users', {
    adminId: req.user?.id,
    count: result.users.length,
    total: result.total,
  });

  return res.status(200).json({
    success: true,
    data: { items: result.users, total: result.total },
  });
});

// ── GET /api/v1/admin/users/:userId ──────────────────────────────────────

const getUser = asyncHandler(async (req, res) => {
  const user = await usersService.getUser(req.params.userId);

  logger.info('[AdminUsers] Viewed user detail', {
    adminId: req.user?.id,
    targetUserId: req.params.userId,
  });

  return res.status(200).json({ success: true, data: user });
});

// ── PATCH /api/v1/admin/users/:userId/role (WP-ADMIN-04E) ────────────────

/**
 * `role` is already restricted to usersRepo.ROLES by the route-level
 * `isIn()` validator — see adminUsers.routes.js.
 *
 * Self-role-change guard mirrors the existing SELF_DEMOTE precedent in
 * routes/admin/adminContributors.routes.js (`/demote`) rather than
 * inventing a new safety pattern: an admin cannot change their own role
 * through this endpoint, avoiding accidental self-lockout.
 */
const updateUserRole = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { role } = req.body;

  if (userId === req.user?.id) {
    throw AppError.forbidden(
      'You cannot change your own role.',
      ErrorCodes.FORBIDDEN,
      { userId }
    );
  }

  const user = await usersService.updateUserRole(userId, role, req.user?.id);

  logger.info('[AdminUsers] Updated user role', {
    adminId: req.user?.id,
    targetUserId: userId,
    role,
  });

  return res.status(200).json({ success: true, data: user });
});

module.exports = { listUsers, getUser, updateUserRole };
