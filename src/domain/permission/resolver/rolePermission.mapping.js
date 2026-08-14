'use strict';

/**
 * @file src/domain/permission/resolver/rolePermission.mapping.js
 *
 * WP-ADMIN-04F-10 — Role ↔ Permission Integration
 * WP-ADMIN-04F-12A — Enterprise Role Permission Catalog Population
 *
 * The single, centralized Role → Permission mapping (WP-ADMIN-04F-10 §7
 * "Implement a centralized mapping. Do NOT scatter mappings across
 * controllers or middleware."). This module is pure data, mirroring
 * `../permission.constants.js`'s "pure data, no logic" convention —
 * ../resolver/rolePermission.resolver.js is the only place this map is
 * read.
 *
 * ── Population (WP-ADMIN-04F-12A) ───────────────────────────────────
 * WP-ADMIN-04F-10 shipped this mapping's infrastructure with every Role
 * deliberately left empty, naming that business decision explicitly out
 * of its own scope (see git history / that WP's own header for the
 * "infrastructure vs. data" split this module used to describe). This
 * WP makes exactly the minimal instance of that decision the certified
 * platform currently requires: the Permission Administration UI and API
 * (WP-ADMIN-04F-08/09) gate every route behind `administration:<verb>`
 * (`../middleware/permission.middleware.js` via
 * `permissionAdmin.routes.js`), and WP-ADMIN-04F-12's diagnostic
 * investigation traced a production 403 directly to this map being
 * empty — an authenticated `admin` had no way to hold
 * `administration:view/create/delete` short of a (today, in-memory-only)
 * explicit Assignment.
 *
 * `ADMIN` and `SUPER_ADMIN` are therefore granted the complete Initial
 * Enterprise Permission Catalog (WP-ADMIN-04F-11,
 * `../permission.catalog.js`) — every Permission that catalog defines,
 * not a hand-picked subset, so this mapping and the catalog can't
 * silently drift apart as the catalog grows. `USER` and `CONTRIBUTOR`
 * are left empty: neither role has any certified reason to manage the
 * Permission system itself, and WP-ADMIN-04F-10's "do not invent a
 * mapping" caution still applies to any grant this WP has no diagnostic
 * or certified basis for making.
 *
 * Identities are derived via `{ resource, action }` pairs read directly
 * off `INITIAL_PERMISSION_CATALOG`'s own Permission objects — never as
 * hand-typed string literals — so `RolePermissionResolver`'s
 * `buildPermissionName(resource, action)` (the same certified identity
 * convention every other layer in this domain uses) remains the single
 * place an identity string is ever assembled.
 *
 * Shape: `{ [role]: ReadonlyArray<{ resource, action }> }`, using the
 * same `{ resource, action }` pair shape every other Permission-domain
 * request already uses (e.g. `permission.assignment.service.js`'s
 * `hasAssignment({ principalId, resource, action })`).
 */

const { ROLES } = require('./roles.constants');
const { INITIAL_PERMISSION_CATALOG } = require('../permission.catalog');

/**
 * The full Initial Enterprise Permission Catalog, reduced to the
 * `{ resource, action }` pair shape this mapping (and
 * `RolePermissionResolver`) expects — deliberately re-derived from the
 * catalog's own Permission objects rather than re-typed, so adding a
 * Permission to the catalog is the only edit needed to extend what
 * `ADMIN_AND_SUPER_ADMIN_GRANTS` grants.
 * @type {ReadonlyArray<{resource: string, action: string}>}
 */
const ADMIN_AND_SUPER_ADMIN_GRANTS = Object.freeze(
  INITIAL_PERMISSION_CATALOG.map(({ resource, action }) => Object.freeze({ resource, action })),
);

const ROLE_PERMISSION_MAP = Object.freeze({
  [ROLES.USER]: Object.freeze([]),
  [ROLES.CONTRIBUTOR]: Object.freeze([]),
  [ROLES.ADMIN]: ADMIN_AND_SUPER_ADMIN_GRANTS,
  [ROLES.SUPER_ADMIN]: ADMIN_AND_SUPER_ADMIN_GRANTS,
});

module.exports = {
  ROLE_PERMISSION_MAP,
};
