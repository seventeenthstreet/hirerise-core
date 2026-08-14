'use strict';

/**
 * @file src/domain/permission/resolver/rolePermission.errors.js
 *
 * WP-ADMIN-04F-10 — Role ↔ Permission Integration
 *
 * Named error hierarchy for the Role Permission Resolver, following the
 * same per-layer convention as every other layer in this domain (Domain,
 * Repository, Registry, Governance, Evaluation, Assignment, Middleware).
 * A Resolver-layer error is never a Domain shape problem, never an
 * Assignment-request problem — it is specifically a malformed-input
 * problem for the Role→Permission translation itself.
 *
 * Deliberately excludes an "unknown role" error: per WP-ADMIN-04F-10 §3
 * and §9 (Backward Compatibility), a role with no mapping entry resolves
 * to an empty grant set rather than throwing, so existing `role === ...`
 * checks elsewhere in the codebase are never disturbed by this module.
 */

/**
 * Base class for every error this module throws. Never thrown directly
 * — always one of the named subclasses below.
 */
class RolePermissionResolverError extends Error {
  /**
   * @param {string} message
   * @param {string} code - machine-readable error code
   * @param {object} [metadata]
   */
  constructor(message, code, metadata = {}) {
    super(message);
    this.name = 'RolePermissionResolverError';
    this.code = code;
    this.metadata = metadata;
    Error.captureStackTrace?.(this, RolePermissionResolverError);
  }
}

/**
 * Thrown when `RolePermissionResolver.resolve()` is called with a value
 * that is not a non-empty string — a malformed-input problem, distinct
 * from a well-formed but unmapped role (see file header).
 */
class InvalidRoleError extends RolePermissionResolverError {
  /**
   * @param {*} value - the invalid role value
   * @param {object} [metadata]
   */
  constructor(value, metadata = {}) {
    super(`[RolePermissionResolver] invalid role: ${JSON.stringify(value)}`, 'ROLE_PERMISSION_INVALID_ROLE', {
      value,
      ...metadata,
    });
    this.name = 'InvalidRoleError';
    Error.captureStackTrace?.(this, InvalidRoleError);
  }
}

module.exports = {
  RolePermissionResolverError,
  InvalidRoleError,
};
