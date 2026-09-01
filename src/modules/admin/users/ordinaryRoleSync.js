'use strict';

/**
 * ordinaryRoleSync.js — WP-ADMIN-04G Ordinary Role Synchronization
 *
 * Server-side-only projection of an ordinary role (`user` | `contributor` |
 * `editor`) onto the corresponding Supabase Auth user's `app_metadata`.
 *
 * WHY THIS EXISTS:
 *   Per the WP-ADMIN-04G investigation ("Ordinary Role Synchronization
 *   Reconciliation"), `auth.middleware.js#buildClaimSet()` builds
 *   `req.user.role` from Auth `app_metadata.role` only — never from
 *   `public.users.role`. Before this module, `adminUsers.repository.js
 *   #updateRole()` wrote only `public.users.role`, so a role change made
 *   through the User Directory (PATCH /admin/users/:userId/role) was
 *   persisted but never became the target user's effective authorization
 *   role. This module closes that gap for the three ordinary roles only.
 *
 *   It reuses shared/auth/roleAuthProjection.js#projectRoleToAuthMetadata()
 *   — the exact same read-modify-write Supabase Auth Admin API call that
 *   modules/admin/bootstrap/adminAuthSync.js#syncAdminRoleToAuth() uses for
 *   the Administrator lifecycle — so there is exactly one implementation of
 *   "write role/roles onto app_metadata, preserving everything else."
 *
 * SCOPE / SECURITY BOUNDARY:
 *   - This module must only ever be called with a role from
 *     adminUsers.repository.js's ASSIGNABLE_ROLES ('user', 'contributor',
 *     'editor'). It performs no role-vocabulary validation itself — that is
 *     enforced upstream by adminUsers.routes.js's `isIn(ASSIGNABLE_ROLES)`
 *     validator, the same defense-in-depth boundary already documented on
 *     that route. This module does not call, and must never be made to
 *     call, admin_principals or any Administrator-lifecycle code — granting
 *     admin / super_admin / MASTER_ADMIN remains exclusively
 *     administrators.service.js's responsibility.
 *   - Never throws: failure is reported back as
 *     `{ synchronized: false, error }`, mirroring syncAdminRoleToAuth()'s
 *     contract, so a partially-successful role change (DB updated, Auth
 *     projection failed) is never silently reported as fully effective.
 */

const logger = require('../../../utils/logger');
const { projectRoleToAuthMetadata } = require('../../../shared/auth/roleAuthProjection');

/**
 * Project an ordinary role onto the Auth user `uid`'s app_metadata.
 *
 * @param {string} uid
 * @param {string} role  — must already be one of ASSIGNABLE_ROLES
 * @returns {Promise<{ synchronized: boolean, error: string|null }>}
 */
async function syncOrdinaryRoleToAuth(uid, role) {
  const result = await projectRoleToAuthMetadata(uid, role);

  if (!result.synchronized) {
    logger.error('[OrdinaryRoleSync] Failed to project ordinary role onto Auth app_metadata', {
      uid,
      role,
      error: result.error,
    });
  }

  return result;
}

module.exports = { syncOrdinaryRoleToAuth };
