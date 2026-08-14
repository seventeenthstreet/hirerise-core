'use strict';

/**
 * @file src/domain/permission/resolver/rolePermission.resolver.js
 *
 * WP-ADMIN-04F-10 — Role ↔ Permission Integration
 *
 * `RolePermissionResolver` — the dedicated resolver named in
 * WP-ADMIN-04F-10 §3. Its only responsibility is translating a Role
 * (from the existing, certified Role-Based Authorization system) into
 * the set of Permission identities that Role carries, by reading
 * `./rolePermission.mapping.js`. Per the WP:
 *
 *   - The resolver must not perform authorization — it never calls the
 *     Evaluation Engine and returns no Allow/Deny Decision.
 *   - The resolver must not perform assignment — it never calls the
 *     Assignment Service and creates no Assignment records. Composing
 *     this Resolver's output with explicit Assignments is
 *     `./permissionGrant.resolver.js`'s job, not this module's.
 *   - It only translates Roles into Permission identities.
 *
 * ── Caching ──────────────────────────────────────────────────────────
 * WP-ADMIN-04F-10 §8 requires any cache introduced here to be immutable
 * with no request-scoped mutation. Because `ROLE_PERMISSION_MAP` is
 * itself static, frozen, in-process data (not a per-request or
 * per-principal value), the entire resolvable surface is known at
 * construction time — so the cache is built once, in the constructor,
 * from the mapping, rather than lazily populated per call. `resolve()`
 * itself never mutates any shared state.
 */

const { buildPermissionName } = require('../permission.model');
const { ROLE_PERMISSION_MAP: defaultMapping } = require('./rolePermission.mapping');
const { InvalidRoleError } = require('./rolePermission.errors');

const EMPTY_RESULT = Object.freeze([]);

class RolePermissionResolver {
  /**
   * @param {Object.<string, ReadonlyArray<{resource: string, action: string}>>} [mapping]
   *   Defaults to the shared, centralized `ROLE_PERMISSION_MAP`.
   */
  constructor(mapping = defaultMapping) {
    this._cache = RolePermissionResolver._buildCache(mapping);
  }

  /**
   * Builds the immutable role → frozen Permission-identity-array cache
   * once, at construction time. A Role with a mapping entry but no
   * granted pairs (or any Role absent from the mapping entirely) is not
   * cached differently from an unmapped one — both resolve to the same
   * shared, frozen empty array. See ./rolePermission.errors.js's header
   * for why an unmapped Role is not an error.
   * @private
   */
  static _buildCache(mapping) {
    const cache = new Map();
    if (!mapping || typeof mapping !== 'object') {
      return cache;
    }
    for (const [role, pairs] of Object.entries(mapping)) {
      const identities = Array.isArray(pairs)
        ? pairs.map((pair) => buildPermissionName(pair.resource, pair.action))
        : [];
      cache.set(role, Object.freeze(identities));
    }
    return cache;
  }

  /**
   * Resolves a Role into the frozen list of Permission identities
   * (`"resource:action"`) that Role carries. A Role unknown to the
   * mapping resolves to a frozen empty array rather than throwing —
   * required by WP-ADMIN-04F-10 §9 (Backward Compatibility): existing
   * `role === ...` checks elsewhere in the codebase must keep working
   * unmodified, including for roles this integration layer does not yet
   * know about.
   *
   * @param {string} role
   * @returns {ReadonlyArray<string>} frozen array of Permission identities
   */
  resolve(role) {
    if (typeof role !== 'string' || role.length === 0) {
      throw new InvalidRoleError(role);
    }
    return this._cache.get(role) ?? EMPTY_RESULT;
  }
}

module.exports = {
  RolePermissionResolver,
  // Convenience singleton, matching this domain's existing singleton
  // convention (see e.g. permission.registry.js's `permissionRegistry`,
  // permission.assignment.service.js's `permissionAssignmentService`).
  rolePermissionResolver: new RolePermissionResolver(),
};
