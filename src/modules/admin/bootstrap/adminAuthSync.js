'use strict';

/**
 * adminAuthSync.js — WP-ADMIN-IMP-07
 *
 * Server-side-only projection of a granted admin_principals role onto the
 * corresponding Supabase Auth user's `app_metadata`.
 *
 * WHY THIS EXISTS:
 *   requireMasterAdmin / requireAdmin authorize primarily from the caller's
 *   JWT claims (`req.user.role` / `req.user.roles`). Those claims are built
 *   by auth.middleware.js#buildClaimSet() directly from the Supabase Auth
 *   user's `app_metadata.role` / `app_metadata.roles` — never from
 *   admin_principals directly (see that file's doc comment: "req.user
 *   contract"). admin_principals is the canonical lifecycle authority
 *   record (WP-ADMIN-INTEL-06), but until this module existed nothing
 *   projected a newly granted role from admin_principals into Auth
 *   app_metadata, so a freshly bootstrapped/granted principal's JWT would
 *   never actually carry the MASTER_ADMIN claim. This module is that
 *   projection, and *only* that projection:
 *     admin_principals (authority)  ---->  Auth app_metadata (derived)
 *   It never reads FROM app_metadata to make an authorization decision,
 *   and it never writes to admin_principals. See WP-ADMIN-IMP-07 §10.
 *
 * SCOPE: this module is called by the bootstrap path only (§10/§18 of
 * WP-ADMIN-IMP-07 — narrowly scoped to bootstrap recovery, not a general
 * Administrator-lifecycle refactor). Wiring the same projection into the
 * ordinary grant/suspend/revoke/reactivate lifecycle endpoints
 * (adminAuth.routes.js) is explicitly out of scope for this work package
 * and is called out as a follow-up in the implementation report.
 *
 * SECURITY:
 *   - Uses the existing service-role Supabase client from config/supabase.js
 *     (already server-only; never constructed or exposed in browser code).
 *   - Never trusts or reads Auth state to grant access — DB lifecycle
 *     status (admin_principals) remains the sole authority; this module
 *     only ever writes a value that a repository-layer lifecycle mutation
 *     has already committed.
 *   - Read-modify-write against the user's existing app_metadata (rather
 *     than a blind overwrite) so unrelated app_metadata keys Supabase or
 *     other modules may have set (e.g. `provider`, `plan`) are preserved.
 *   - Never throws: failure is reported back to the caller as
 *     `{ synchronized: false, error }` rather than swallowed, so the
 *     caller (adminBootstrap.service.js) can surface it explicitly and
 *     auditably instead of silently claiming synchronized authority
 *     (WP-ADMIN-IMP-07 §12 — Auth synchronization failure must be explicit
 *     and auditable, and must never be reported as success).
 *
 * WP-ADMIN-04G — the actual Supabase Auth read-modify-write call this
 * function makes was extracted verbatim into
 * shared/auth/roleAuthProjection.js#projectRoleToAuthMetadata() so the
 * ordinary-role path (user/contributor/editor — see
 * modules/admin/users/ordinaryRoleSync.js) can reuse the identical
 * projection logic rather than duplicating this Supabase Auth Admin API
 * call in a second place. This function's name, signature, return shape,
 * logging, and Administrator-specific semantics are all unchanged — it is
 * still the sole entry point the Administrator lifecycle
 * (administrators.service.js, adminBootstrap.service.js) calls.
 */

const logger = require('../../../utils/logger');
const { projectRoleToAuthMetadata } = require('../../../shared/auth/roleAuthProjection');

/**
 * Project `role` onto the Auth user `uid`'s app_metadata.role/roles.
 *
 * @param {string} uid
 * @param {string} role
 * @returns {Promise<{ synchronized: boolean, error: string|null }>}
 */
async function syncAdminRoleToAuth(uid, role) {
  const result = await projectRoleToAuthMetadata(uid, role);

  if (!result.synchronized) {
    logger.error('[AdminAuthSync] Failed to project admin_principals role onto Auth app_metadata', {
      uid,
      role,
      error: result.error,
    });
  }

  return result;
}

module.exports = { syncAdminRoleToAuth };
