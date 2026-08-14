'use strict';

/**
 * @file src/domain/permission/resolver/permissionGrant.resolver.js
 *
 * WP-ADMIN-04F-10 — Role ↔ Permission Integration
 *
 * `PermissionGrantResolver` — the effective-grant composition point
 * introduced by the WP-ADMIN-04F-10 architectural refinement. A single
 * request may be granted a Permission two ways: an explicit Assignment
 * (`../assignment/permission.assignment.service.js`, unchanged, still
 * the single source of *explicit* grants) or a Role-derived Permission
 * (`./rolePermission.resolver.js`, unchanged from its own file, still
 * only a Role→Permission translation). Composing those two into one
 * effective yes/no answer is this module's entire job, and *only* this
 * module's job:
 *
 *   - `PermissionAssignmentService` is not modified to know about Roles
 *     — it remains responsible only for explicit assignment storage and
 *     retrieval, exactly as before this WP.
 *   - `RolePermissionResolver` is not modified to know about
 *     Assignments — it remains a pure Role→Permission translation.
 *   - `Authorization Middleware` (../middleware/permission.middleware.js)
 *     no longer composes these two collaborators itself — it consumes
 *     this Resolver's single `hasGrant()` call instead, per this WP's
 *     Middleware Integration requirement ("without changing request
 *     flow" — the middleware's Evaluate-then-Assignment-check *shape*
 *     is unchanged; only what answers the second half moved here).
 *
 * This module performs no authorization evaluation itself (that
 * remains the Evaluation Engine's job, called directly by the
 * Middleware, unchanged) — `hasGrant()` answers only "does this
 * Principal hold this Permission, explicitly or via their Role",
 * exactly the question the Middleware previously asked
 * `assignmentService.hasAssignment()` alone.
 */

const { permissionAssignmentService: defaultAssignmentService } = require('../assignment/permission.assignment.service');
const { buildPermissionName } = require('../permission.model');
const { rolePermissionResolver: defaultRolePermissionResolver } = require('./rolePermission.resolver');
const { InvalidGrantRequestError } = require('./permissionGrant.errors');

/**
 * Validates the shape of a grant-lookup request. Role is optional in
 * shape (a `null`/absent Role is valid — see `hasGrant()` below) but,
 * when present, must be a non-empty string; every other field is
 * required.
 * @private
 */
function validateGrantRequestShape(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new InvalidGrantRequestError('request must be a non-null object', {
      received: request === null ? 'null' : typeof request,
    });
  }
  const { principalId, role, resource, action } = request;
  if (typeof principalId !== 'string' || principalId.length === 0) {
    throw new InvalidGrantRequestError('request requires a non-empty string "principalId"', { received: principalId });
  }
  if (role !== null && role !== undefined && (typeof role !== 'string' || role.length === 0)) {
    throw new InvalidGrantRequestError('request "role", when provided, must be a non-empty string', { received: role });
  }
  if (typeof resource !== 'string' || resource.length === 0) {
    throw new InvalidGrantRequestError('request requires a non-empty string "resource"', { received: resource });
  }
  if (typeof action !== 'string' || action.length === 0) {
    throw new InvalidGrantRequestError('request requires a non-empty string "action"', { received: action });
  }
}

class PermissionGrantResolver {
  /**
   * @param {import('../assignment/permission.assignment.service').PermissionAssignmentService} [assignmentService]
   *   Defaults to the shared certified Assignment Service singleton.
   * @param {import('./rolePermission.resolver').RolePermissionResolver} [rolePermissionResolver]
   *   Defaults to the shared Role Permission Resolver singleton.
   */
  constructor(assignmentService = defaultAssignmentService, rolePermissionResolver = defaultRolePermissionResolver) {
    this._assignmentService = assignmentService;
    this._rolePermissionResolver = rolePermissionResolver;
  }

  /**
   * The single effective-grant question: does this Principal hold this
   * Permission, either through an explicit Assignment or through a
   * Permission their Role derives. Explicit Assignment is checked
   * first (it is the cheaper, already-scoped lookup); Role-derivation
   * is only consulted when no explicit Assignment exists, so a
   * Principal authenticated without a resolvable Role (`role` omitted
   * or `null`) is never penalized — they simply fall back to
   * explicit-Assignment-only behavior, identical to this system before
   * WP-ADMIN-04F-10.
   *
   * @param {Object} request
   * @param {string} request.principalId
   * @param {string|null} [request.role] - the Principal's existing,
   *   certified Role (`req.user.role`); omit or pass `null` when no
   *   Role is resolvable.
   * @param {import('../permission.types').Resource} request.resource
   * @param {import('../permission.types').Action} request.action
   * @returns {Promise<boolean>}
   */
  async hasGrant(request) {
    validateGrantRequestShape(request);
    const { principalId, role = null, resource, action } = request;

    const explicit = await this._assignmentService.hasAssignment({ principalId, resource, action });
    if (explicit) {
      return true;
    }

    if (!role) {
      return false;
    }

    const roleGrantedIdentities = this._rolePermissionResolver.resolve(role);
    return roleGrantedIdentities.includes(buildPermissionName(resource, action));
  }
}

module.exports = {
  PermissionGrantResolver,
  // Convenience singleton, matching this domain's existing singleton
  // convention.
  permissionGrantResolver: new PermissionGrantResolver(),
};
