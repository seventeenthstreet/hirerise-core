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
 * WP-ADMIN-COMP-04 — authenticationProvider, accountStatus, and lastLogin
 * are no longer hardcoded placeholders: withAuthState() reads them from
 * Supabase Auth via usersRepo.getAuthState() (see that method's doc
 * comment for why public.users.id can be used directly as the Auth user
 * id). This read is best-effort — if Supabase Auth is unreachable or has
 * no matching record, these three fields fall back to `null` /
 * "Unavailable" exactly as before, rather than failing the whole request;
 * a transient Auth-read failure must never make the User Detail page
 * itself unavailable.
 *
 * mfaStatus remains hardcoded `null`. Per the WP-ADMIN-COMP-04 Repository
 * Reconciliation, this codebase has no user-facing MFA enrollment system
 * at all (the only MFA implementation, modules/admin/mfa, is
 * administrator step-up auth for the admin panel itself, unrelated to
 * regular platform users) — there is nothing to read a status from, so
 * this is left accurately `null` rather than fabricated.
 *
 * @module modules/admin/users/adminUsers.service
 */

const usersRepo = require('./adminUsers.repository');
const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');
const { logAdminAction } = require('../../../utils/adminAuditLogger');
const logger = require('../../../utils/logger');

// WP-ADMIN-COMP-04 — merges the best-effort Supabase Auth read onto a
// user record. mfaStatus has no backing capability anywhere in this
// codebase (see module doc comment) and is always null.
async function withAuthState(user) {
  let authState = null;
  try {
    authState = await usersRepo.getAuthState(user.id);
  } catch (err) {
    // Never let an Auth-read failure fail the surrounding request — the
    // rest of the User Detail payload is still valid and useful.
    logger.warn('[AdminUsers] Auth state lookup failed', {
      userId: user.id,
      error: err?.message,
    });
  }

  return {
    ...user,
    authenticationProvider: authState?.authenticationProvider ?? null,
    accountStatus: authState?.accountStatus ?? null,
    mfaStatus: null,
    lastLogin: authState?.lastLogin ?? null,
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

  return withAuthState(user);
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

  return withAuthState(updated);
}

// ── Edit Profile (WP-ADMIN-COMP-04) ──────────────────────────────────────

/**
 * Updates the application-level profile fields shown on the User Detail
 * page's Identity/Profile cards. `fields` is already restricted to the
 * allow-listed keys by the route layer (see adminUsers.routes.js); the
 * repository re-enforces the same allow-list as a second line of defense.
 *
 * @param {string} userId
 * @param {object} fields   — subset of { displayName, careerGoal,
 *                             targetRole, experienceYears, industry,
 *                             location }, already camelCase-normalized by
 *                             the controller
 * @param {string} adminId
 * @returns {Promise<object>}
 * @throws {AppError} 404 if the user does not exist
 */
async function updateUserProfile(userId, fields, adminId) {
  // camelCase (API contract) -> snake_case (repository/DB contract).
  const columnMap = {
    displayName: 'display_name',
    careerGoal: 'career_goal',
    targetRole: 'target_role',
    experienceYears: 'experience_years',
    industry: 'industry',
    location: 'location',
  };
  const patch = {};
  for (const [camelKey, column] of Object.entries(columnMap)) {
    if (Object.prototype.hasOwnProperty.call(fields, camelKey)) {
      patch[column] = fields[camelKey];
    }
  }

  const updated = await usersRepo.updateProfile(userId, patch);

  if (!updated) {
    throw AppError.notFound('User not found', ErrorCodes.NOT_FOUND, { userId });
  }

  void logAdminAction({
    adminId,
    action: 'USER_PROFILE_UPDATED',
    entityType: 'user',
    entityId: userId,
    metadata: { fields: Object.keys(patch) },
  });

  return withAuthState(updated);
}

// ── Account Status: Enable / Disable (WP-ADMIN-COMP-04) ──────────────────

/**
 * @param {string} userId
 * @param {'enable'|'disable'} action — pre-validated by the route layer
 * @param {string} adminId
 * @returns {Promise<object>}
 * @throws {AppError} 404 if the user does not exist in either public.users
 *   or Supabase Auth
 */
async function setUserAccountStatus(userId, action, adminId) {
  const user = await usersRepo.findById(userId);
  if (!user) {
    throw AppError.notFound('User not found', ErrorCodes.NOT_FOUND, { userId });
  }

  const authState = await usersRepo.setAccountStatus(userId, action);
  if (!authState) {
    // The public.users row exists but there is no corresponding Supabase
    // Auth user to change the status of — surface this distinctly rather
    // than silently no-op'ing.
    throw AppError.notFound(
      'This user has no corresponding authentication record; account status cannot be changed.',
      ErrorCodes.NOT_FOUND,
      { userId }
    );
  }

  void logAdminAction({
    adminId,
    action: action === 'disable' ? 'USER_ACCOUNT_DISABLED' : 'USER_ACCOUNT_ENABLED',
    entityType: 'user',
    entityId: userId,
    metadata: {},
  });

  return {
    ...user,
    authenticationProvider: authState.authenticationProvider,
    accountStatus: authState.accountStatus,
    mfaStatus: null,
    lastLogin: authState.lastLogin,
  };
}

// ── View Audit History (WP-ADMIN-COMP-04) ────────────────────────────────

/**
 * @param {string} userId
 * @param {number} [limit=50]
 * @returns {Promise<object[]>}
 * @throws {AppError} 404 if the user does not exist
 */
async function getUserAuditHistory(userId, limit = 50) {
  const user = await usersRepo.findById(userId);
  if (!user) {
    throw AppError.notFound('User not found', ErrorCodes.NOT_FOUND, { userId });
  }

  const events = await usersRepo.listAuditHistory(userId, limit);

  return events.map((row) => ({
    id: row.id ?? null,
    adminId: row.admin_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  }));
}

module.exports = {
  listUsers,
  getUser,
  updateUserRole,
  updateUserProfile,
  setUserAccountStatus,
  getUserAuditHistory,
};
