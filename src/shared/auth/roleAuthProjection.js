'use strict';

/**
 * roleAuthProjection.js — WP-ADMIN-04G (Ordinary Role Synchronization)
 *
 * Low-level, role-agnostic projection of a role value onto a Supabase Auth
 * user's `app_metadata.role` / `app_metadata.roles`.
 *
 * WHY THIS EXISTS:
 *   This is the read-modify-write pattern originally implemented inline in
 *   `modules/admin/bootstrap/adminAuthSync.js#syncAdminRoleToAuth()`
 *   (WP-ADMIN-IMP-07), extracted verbatim so it can be reused by the
 *   ordinary-role assignment path (WP-ADMIN-04G) without duplicating the
 *   same Supabase Auth Admin API call in two places. `adminAuthSync.js`
 *   now delegates to this module; its own exported function name,
 *   behavior, and Administrator-specific doc comments are unchanged.
 *
 *   This module makes NO authorization decisions and enforces NO role
 *   vocabulary — it is a pure projection primitive. Callers (adminAuthSync.js
 *   for Administrator roles, ordinaryRoleSync.js for user/contributor/editor)
 *   remain responsible for deciding which roles they are allowed to pass in.
 *   Restricting *which* roles reach this function is done entirely by the
 *   caller layer (route validators + ASSIGNABLE_ROLES / admin_principals),
 *   not here — see adminUsers.repository.js's ASSIGNABLE_ROLES and this
 *   module's own callers for where that boundary is actually enforced.
 *
 * SECURITY:
 *   - Uses the existing service-role Supabase client from config/supabase.js
 *     (server-only, never exposed to the browser).
 *   - Read-modify-write against the user's existing app_metadata (rather
 *     than a blind overwrite) so unrelated app_metadata keys (e.g.
 *     `provider`, `plan`) are preserved.
 *   - Never throws: failure is reported back to the caller as
 *     `{ synchronized: false, error }` rather than swallowed, so callers can
 *     surface it explicitly and auditably instead of silently claiming a
 *     role change is fully effective when only the DB half succeeded.
 */

function getSupabase() {
  return require('../../config/supabase').supabase;
}

/**
 * Project `role` onto the Auth user `uid`'s app_metadata.role/roles.
 *
 * @param {string} uid
 * @param {string} role
 * @returns {Promise<{ synchronized: boolean, error: string|null }>}
 */
async function projectRoleToAuthMetadata(uid, role) {
  if (!uid || !role) {
    return { synchronized: false, error: 'uid and role are required' };
  }

  try {
    const supabase = getSupabase();
    const { data: existing, error: readError } = await supabase.auth.admin.getUserById(uid);
    if (readError) throw readError;
    if (!existing?.user) {
      throw new Error(`No Supabase Auth user found for uid ${uid}`);
    }

    const previousAppMetadata = existing.user.app_metadata ?? {};

    const { error: writeError } = await supabase.auth.admin.updateUserById(uid, {
      app_metadata: {
        ...previousAppMetadata,
        role,
        roles: [role],
      },
    });
    if (writeError) throw writeError;

    return { synchronized: true, error: null };
  } catch (err) {
    // Caller-supplied logger context (uid/role) is logged by the caller,
    // not here, so this module stays free of any Administrator- or
    // ordinary-role-specific logging assumptions.
    return { synchronized: false, error: err?.message ?? String(err) };
  }
}

module.exports = { projectRoleToAuthMetadata };
