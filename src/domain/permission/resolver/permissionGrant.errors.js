'use strict';

/**
 * @file src/domain/permission/resolver/permissionGrant.errors.js
 *
 * WP-ADMIN-04F-10 — Role ↔ Permission Integration
 *
 * Named error hierarchy for the `PermissionGrantResolver` boundary,
 * following this domain's per-layer error convention. A Grant-Resolver
 * error is never an Assignment-request problem (those are
 * `../assignment/permission.assignment.errors.js`'s, and are reused
 * as-is when the Grant Resolver composes with the Assignment Service —
 * see permissionGrant.resolver.js) and never a Role-resolution problem
 * (`./rolePermission.errors.js`'s) — it is specifically a malformed
 * *grant lookup request* (missing/invalid `principalId`, `role`,
 * `resource`, or `action`) caught before either collaborator is
 * consulted.
 */

class PermissionGrantResolverError extends Error {
  /**
   * @param {string} message
   * @param {string} code - machine-readable error code
   * @param {object} [metadata]
   */
  constructor(message, code, metadata = {}) {
    super(message);
    this.name = 'PermissionGrantResolverError';
    this.code = code;
    this.metadata = metadata;
    Error.captureStackTrace?.(this, PermissionGrantResolverError);
  }
}

/**
 * Thrown for a malformed grant-lookup request — a non-object request,
 * or a missing/non-string `principalId`, `role`, `resource`, or
 * `action`.
 */
class InvalidGrantRequestError extends PermissionGrantResolverError {
  /**
   * @param {string} message
   * @param {object} [metadata]
   */
  constructor(message, metadata = {}) {
    super(`[PermissionGrantResolver] ${message}`, 'GRANT_INVALID_REQUEST', metadata);
    this.name = 'InvalidGrantRequestError';
    Error.captureStackTrace?.(this, InvalidGrantRequestError);
  }
}

module.exports = {
  PermissionGrantResolverError,
  InvalidGrantRequestError,
};
