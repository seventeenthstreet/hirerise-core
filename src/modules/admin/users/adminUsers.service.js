'use strict';

/**
 * adminUsers.service.js — Admin User Directory Business Logic
 *
 * WP-ADMIN-04 Phase 1B (read-only); profile fields extended by WP-ADMIN-04C;
 * first write path (role update) added by WP-ADMIN-04E.
 *
 * Per the WP-ADMIN-04 Phase 1A / WP-ADMIN-04C audits: authenticationProvider,
 * accountStatus, mfaStatus, and lastLogin are NOT available on public.users
 * and are not exposed by any other endpoint in this codebase today (they
 * would require reading Supabase Auth's auth.users table, which no
 * admin-facing endpoint currently does, and which WP-ADMIN-04C explicitly
 * keeps out of scope). These are returned as `null` — never inferred or
 * fabricated — so the frontend can render "Unavailable". Both getUser() and
 * updateUserRole() route their result through withAuthPlaceholders() so the
 * response shape is identical whichever one the frontend just called.
 *
 * getUser() otherwise returns whatever usersRepo.findById() resolves,
 * unmodified — WP-ADMIN-04C's additional profile fields (userType,
 * careerGoal, targetRole, experienceYears, industry, location, updatedAt)
 * flow through via the `...user` spread with no service-layer changes
 * beyond this comment.
 *
 * WP-ADMIN-04E — updateUserRole(): the requested role is already validated
 * against usersRepo.ROLES by adminUsers.routes.js's `isIn(ROLES)` (single
 * source of truth — see the repository's ROLES export), so this function
 * does not re-validate; that would duplicate the same rule in a second
 * place. `public.users.users_role_check` remains the final DB-level guard.
 * On success, fires a fire-and-forget audit log entry via the existing
 * utils/adminAuditLogger.js (admin_logs table) — the same audit trail
 * modules/admin/mfa/mfa.service.js already writes to; no new audit
 * mechanism introduced.
 *
 * @module modules/admin/users/adminUsers.service
 */

const usersRepo = require('./adminUsers.repository');
const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');
const { logAdminAction } = require('../../../utils/adminAuditLogger');

// Not available from any existing API — see module doc comment above.
function withAuthPlaceholders(user) {
  return {
    ...user,
    authenticationProvider: null,
    accountStatus: null,
    mfaStatus: null,
    lastLogin: null,
  };
}

// ── List Users ────────────────────────────────────────────────────────────

/**
 * @param {object} options — { limit, offset, search }
 * @returns {Promise<{ users: object[], total: number }>}
 */
async function listUsers({ limit = 50, offset = 0, search } = {}) {
  const result = await usersRepo.list({ search, limit, offset });
  return { users: result.items, total: result.total };
}

// ── Get User Detail ──────────────────────────────────────────────────────

/**
 * @param {string} userId
 * @returns {Promise<object>}
 * @throws {AppError} 404 if not found
 */
async function getUser(userId) {
  const user = await usersRepo.findById(userId);

  if (!user) {
    throw AppError.notFound('User not found', ErrorCodes.NOT_FOUND, { userId });
  }

  return withAuthPlaceholders(user);
}

// ── Update User Role (WP-ADMIN-04E) ──────────────────────────────────────

/**
 * @param {string} userId
 * @param {string} role     — pre-validated by the route layer against
 *                            usersRepo.ROLES
 * @param {string} adminId  — req.user.id of the acting administrator, for
 *                            the audit log entry
 * @returns {Promise<object>}
 * @throws {AppError} 404 if the user does not exist
 */
async function updateUserRole(userId, role, adminId) {
  const updated = await usersRepo.updateRole(userId, role);

  if (!updated) {
    throw AppError.notFound('User not found', ErrorCodes.NOT_FOUND, { userId });
  }

  // Fire-and-forget — logAdminAction() never throws, so a logging failure
  // can never fail the request that already succeeded.
  void logAdminAction({
    adminId,
    action: 'USER_ROLE_UPDATED',
    entityType: 'user',
    entityId: userId,
    metadata: { toRole: role },
  });

  return withAuthPlaceholders(updated);
}

module.exports = { listUsers, getUser, updateUserRole };
