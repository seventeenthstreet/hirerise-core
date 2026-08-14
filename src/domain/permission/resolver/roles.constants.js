'use strict';

/**
 * @file src/domain/permission/resolver/roles.constants.js
 *
 * WP-ADMIN-04F-10 — Role ↔ Permission Integration
 *
 * Canonical `ROLES` vocabulary for the existing, certified Role-Based
 * Authorization system (`public.users.role`). Before this module, every
 * consumer of `req.user.role` (src/middleware/{requireAdmin,
 * requireAdminRoleClaim,requireMasterAdmin,requirePaidPlan,
 * requireContributor,verifyAdmin}.middleware.js, auth.middleware.js, and
 * several controllers) declared its own inline role-string literals —
 * confirmed by the WP-ADMIN-04F-10 repository audit. This module names
 * that existing vocabulary; it does not introduce a new one.
 *
 * Scope, per WP-ADMIN-04F-10 (integration only — no Role redesign):
 *   - This is additive. Existing `role === 'admin'`-style checks are
 *     left exactly as they are; nothing here requires them to migrate.
 *   - `ROLES` exists so ../resolver/rolePermission.mapping.js has a
 *     stable, typo-proof key set to map from — it is not a general
 *     replacement for every role literal in the codebase.
 *   - Values are the existing role strings observed in
 *     `req.user.role` / `req.user.customClaims.role` across the audited
 *     middleware and controllers. No role is invented here.
 */

const ROLES = Object.freeze({
  USER: 'user',
  CONTRIBUTOR: 'contributor',
  ADMIN: 'admin',
  SUPER_ADMIN: 'super_admin',
});

const VALID_ROLES = Object.freeze(Object.values(ROLES));

module.exports = {
  ROLES,
  VALID_ROLES,
};
