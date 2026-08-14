'use strict';

/**
 * @file src/domain/permission/permission.catalog.js
 *
 * WP-ADMIN-04F-11 — Enterprise Permission Catalog Initialization
 *
 * The Initial Enterprise Permission Catalog: the certified, minimal set
 * of Permissions the platform ships with, built via the certified domain
 * factory `createPermission()` (`./permission.model.js`) and the
 * certified vocabulary (`./permission.constants.js`) — never as
 * hand-typed literals, so every entry here is guaranteed well-formed and
 * validated the same way any other Permission in the domain is.
 *
 * This module is pure data, mirroring `./permission.constants.js`'s
 * "pure data, no logic" convention. It is the single source of truth
 * `./resolver/rolePermission.mapping.js` re-derives
 * `ADMIN_AND_SUPER_ADMIN_GRANTS` from.
 *
 * Catalog membership (as approved under WP-ADMIN-04F-11 and mirrored,
 * for traceability only, by
 * `supabase/migrations/20260806000000_wp_admin_04f_11_permission_catalog_initialization.sql`):
 *   - administration:view
 *   - administration:create
 *   - administration:delete
 *
 * Adding, retiring, or recategorizing a Permission is a new governance
 * decision — extend this array (and introduce a corresponding forward
 * migration), never rewrite the SQL migration above to "stay in sync".
 *
 * @type {ReadonlyArray<import('./permission.types').Permission>}
 */

const { RESOURCES, ACTIONS, PERMISSION_CATEGORIES, PERMISSION_STATUS } = require('./permission.constants');
const { createPermission } = require('./permission.model');

const INITIAL_PERMISSION_CATALOG = Object.freeze(
  [
    {
      resource: RESOURCES.ADMINISTRATION,
      action: ACTIONS.VIEW,
      category: PERMISSION_CATEGORIES.ADMINISTRATION,
      status: PERMISSION_STATUS.PUBLISHED,
    },
    {
      resource: RESOURCES.ADMINISTRATION,
      action: ACTIONS.CREATE,
      category: PERMISSION_CATEGORIES.ADMINISTRATION,
      status: PERMISSION_STATUS.PUBLISHED,
    },
    {
      resource: RESOURCES.ADMINISTRATION,
      action: ACTIONS.DELETE,
      category: PERMISSION_CATEGORIES.ADMINISTRATION,
      status: PERMISSION_STATUS.PUBLISHED,
    },
  ].map((input) => createPermission(input)),
);

module.exports = Object.freeze({
  INITIAL_PERMISSION_CATALOG,
});
