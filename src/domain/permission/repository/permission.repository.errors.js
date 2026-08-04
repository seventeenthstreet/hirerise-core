'use strict';

/**
 * @file src/domain/permission/repository/permission.repository.errors.js
 *
 * WP-ADMIN-04F-02 — Permission Repository
 *
 * Named error classes for the Permission Repository boundary, following
 * the same standalone-hierarchy convention already established by:
 *   - the certified domain layer (../permission.errors.js)
 *   - the Snapshot Repository (modules/snapshot-intelligence/repository/errors/snapshot.repository.errors.js)
 *
 * A base class carrying a machine-readable `code` and free-form
 * `metadata`, with named subclasses for every distinct failure mode a
 * repository consumer needs to branch on. PermissionRepositoryError is
 * never thrown directly — always one of the named subclasses below.
 *
 * These are deliberately infrastructure-neutral: nothing in
 * permission.repository.js lets a raw Supabase/PostgREST error escape
 * across the repository boundary — every failure is translated into one
 * of these classes first. This is a repository-layer error hierarchy,
 * distinct from ../permission.errors.js (which guards *domain entity
 * construction*, not persistence) — a malformed persisted row surfaces as
 * PermissionMappingError here, wrapping whichever ../permission.errors.js
 * class the domain factory raised, rather than that class leaking through
 * directly.
 */

class PermissionRepositoryError extends Error {
  /**
   * @param {string} message
   * @param {string} code - machine-readable error code
   * @param {object} [metadata]
   */
  constructor(message, code, metadata = {}) {
    super(message);
    this.name = 'PermissionRepositoryError';
    this.code = code;
    this.metadata = metadata;
    Error.captureStackTrace?.(this, PermissionRepositoryError);
  }
}

/**
 * Thrown by an operation for which "not found" is an error condition for
 * the caller (there is none in this repository's public surface today —
 * findById/findByName return `null` on a miss, per convention — but this
 * exists for any future caller-facing "getOrThrow" helper, mirroring the
 * Snapshot Repository's SnapshotNotFoundError).
 */
class PermissionNotFoundError extends PermissionRepositoryError {
  constructor(message, metadata = {}) {
    super(message, 'PERMISSION_NOT_FOUND', metadata);
    this.name = 'PermissionNotFoundError';
  }
}

/**
 * Thrown when create() is asked to persist a Permission whose canonical
 * `name` (`${resource}:${action}`, AUTH-04 §7 Stable Permission Identity)
 * already exists. The repository checks this proactively (existsByName)
 * before insert, rather than parsing a driver-specific unique-violation
 * error code, so this error is raised consistently regardless of which
 * persistence adapter is behind the repository.
 */
class PermissionDuplicateError extends PermissionRepositoryError {
  constructor(message, metadata = {}) {
    super(message, 'PERMISSION_DUPLICATE', metadata);
    this.name = 'PermissionDuplicateError';
  }
}

/**
 * Thrown when a repository-layer input (a create/update payload, a
 * lookup argument) fails repository-boundary validation. Distinct from
 * the domain layer's Invalid*Error classes (../permission.errors.js),
 * which guard entity construction — this one guards the repository's own
 * argument surface (e.g. a missing id, an empty name) before any domain
 * factory is even called.
 */
class PermissionRepositoryValidationError extends PermissionRepositoryError {
  constructor(message, metadata = {}) {
    super(message, 'PERMISSION_REPOSITORY_VALIDATION_ERROR', metadata);
    this.name = 'PermissionRepositoryValidationError';
  }
}

/**
 * Thrown when a persisted row cannot be mapped back into a well-formed
 * domain Permission (i.e. the domain factory/validator rejected it — a
 * corrupt or out-of-band-written row). Wraps the originating
 * ../permission.errors.js error in `metadata.cause` rather than letting
 * it escape directly, keeping this repository's error surface self
 * contained.
 */
class PermissionMappingError extends PermissionRepositoryError {
  constructor(message, metadata = {}) {
    super(message, 'PERMISSION_MAPPING_ERROR', metadata);
    this.name = 'PermissionMappingError';
  }
}

/**
 * Thrown when an implementation of the PermissionRepository contract
 * (./permission.repository.contract.js) does not satisfy the required
 * method surface. A programming-time / wiring error, not a runtime data
 * error — mirrors SnapshotRepositoryContractViolationError.
 */
class PermissionRepositoryContractViolationError extends PermissionRepositoryError {
  constructor(message, metadata = {}) {
    super(message, 'PERMISSION_REPOSITORY_CONTRACT_VIOLATION', metadata);
    this.name = 'PermissionRepositoryContractViolationError';
  }
}

module.exports = {
  PermissionRepositoryError,
  PermissionNotFoundError,
  PermissionDuplicateError,
  PermissionRepositoryValidationError,
  PermissionMappingError,
  PermissionRepositoryContractViolationError,
};
