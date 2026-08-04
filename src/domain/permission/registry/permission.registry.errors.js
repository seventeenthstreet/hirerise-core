'use strict';

/**
 * @file src/domain/permission/registry/permission.registry.errors.js
 *
 * WP-ADMIN-04F-03 — Enterprise Permission Registry
 *
 * Named error hierarchy for the Registry boundary, following the same
 * per-layer convention already established by the domain layer
 * (../permission.errors.js) and the repository layer
 * (../repository/permission.repository.errors.js). A Registry-layer error
 * is distinct from both: it is never a domain shape problem (that's
 * already guaranteed by the repository before a Permission ever reaches
 * the Registry) and never a persistence problem (the Registry has no
 * direct database access) — it is either bad input to a Registry method,
 * or a catalog-wide consistency finding (Registry Validation).
 */

class PermissionRegistryError extends Error {
  /**
   * @param {string} message
   * @param {string} code - machine-readable error code
   * @param {object} [metadata]
   */
  constructor(message, code, metadata = {}) {
    super(message);
    this.name = 'PermissionRegistryError';
    this.code = code;
    this.metadata = metadata;
    Error.captureStackTrace?.(this, PermissionRegistryError);
  }
}

/**
 * Thrown when an argument to a Registry method (a lookup value, an
 * options object) fails Registry-boundary validation, before the
 * Repository is ever consulted.
 */
class PermissionRegistryValidationError extends PermissionRegistryError {
  constructor(message, metadata = {}) {
    super(message, 'PERMISSION_REGISTRY_VALIDATION_ERROR', metadata);
    this.name = 'PermissionRegistryValidationError';
  }
}

/**
 * Thrown by `validateCatalog()` reporting helpers is NOT how duplicate
 * identities are surfaced (that method returns a structured report, since
 * "Registry Validation" is a read-oriented consistency *check*, not a
 * write-time gate) — this class exists for any future caller that wants
 * a throwing variant (e.g. `assertCatalogConsistency()`), and is used
 * internally to type a single duplicate finding's `cause`.
 */
class DuplicatePermissionIdentityError extends PermissionRegistryError {
  constructor(message, metadata = {}) {
    super(message, 'PERMISSION_REGISTRY_DUPLICATE_IDENTITY', metadata);
    this.name = 'DuplicatePermissionIdentityError';
  }
}

/**
 * Represents a single catalog entry that does not satisfy the Registry's
 * required-metadata or well-formedness expectations (Registry Validation
 * — "missing required metadata" / "malformed registry entries").
 */
class MalformedRegistryEntryError extends PermissionRegistryError {
  constructor(message, metadata = {}) {
    super(message, 'PERMISSION_REGISTRY_MALFORMED_ENTRY', metadata);
    this.name = 'MalformedRegistryEntryError';
  }
}

module.exports = {
  PermissionRegistryError,
  PermissionRegistryValidationError,
  DuplicatePermissionIdentityError,
  MalformedRegistryEntryError,
};
