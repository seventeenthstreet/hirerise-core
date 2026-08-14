'use strict';

/**
 * @file src/domain/permission/assignment/permission.assignment.errors.js
 *
 * WP-ADMIN-04F-06 — Enterprise Permission Assignment Services
 *
 * Named error hierarchy for the Assignment boundary, following the same
 * per-layer convention as every other layer in this domain (Domain,
 * Repository, Registry, Governance, Evaluation). An Assignment-layer
 * error is never a Domain shape problem, never a raw persistence
 * problem, never a Registry catalog-consistency finding, never a
 * Governance lifecycle-workflow problem, and never an Evaluation
 * authorization-decision problem — it is specifically an
 * assignment-request problem: a request that cannot be assigned or
 * revoked as given.
 *
 * Exactly the five classes named in WP-ADMIN-04F-06's "Assignment
 * Errors" section — no additional classes introduced.
 */

class PermissionAssignmentError extends Error {
  /**
   * @param {string} message
   * @param {string} code - machine-readable error code
   * @param {object} [metadata]
   */
  constructor(message, code, metadata = {}) {
    super(message);
    this.name = 'PermissionAssignmentError';
    this.code = code;
    this.metadata = metadata;
    Error.captureStackTrace?.(this, PermissionAssignmentError);
  }
}

/**
 * Thrown when an Assignment already exists for a given
 * (principalId, permissionIdentity) pair and a caller attempts to create
 * it again through a path that does not tolerate that (the Repository's
 * strict `create()`). The Service's `assignPermission()` is idempotent
 * and deliberately avoids ever triggering this — it checks for an
 * existing Assignment first and returns it rather than calling
 * `create()` a second time. This error exists for Assignment Integrity
 * (WP §5's "duplicate prevention") at the Repository boundary itself.
 */
class DuplicateAssignmentError extends PermissionAssignmentError {
  /**
   * @param {string} assignmentIdentity
   * @param {object} [metadata]
   */
  constructor(assignmentIdentity, metadata = {}) {
    super(
      `[Assignment] an Assignment already exists for "${assignmentIdentity}"`,
      'ASSIGNMENT_DUPLICATE',
      { assignmentIdentity, ...metadata },
    );
    this.name = 'DuplicateAssignmentError';
    Error.captureStackTrace?.(this, DuplicateAssignmentError);
  }
}

/**
 * Thrown by a Repository lookup that requires an Assignment to exist
 * (as opposed to a `find`-style lookup, which returns null). Not raised
 * by `revokePermission()` — repeated revocation is required to be safe
 * (WP §3), so revocation of a non-existent Assignment is a no-op, never
 * this error.
 */
class AssignmentNotFoundError extends PermissionAssignmentError {
  /**
   * @param {string} assignmentIdentity
   * @param {object} [metadata]
   */
  constructor(assignmentIdentity, metadata = {}) {
    super(
      `[Assignment] no Assignment found for "${assignmentIdentity}"`,
      'ASSIGNMENT_NOT_FOUND',
      { assignmentIdentity, ...metadata },
    );
    this.name = 'AssignmentNotFoundError';
    Error.captureStackTrace?.(this, AssignmentNotFoundError);
  }
}

/**
 * Thrown for a malformed assignment or revocation request — missing or
 * non-string `principalId`/`resource`/`action`, a non-object request, or
 * any other request-shape problem caught before Registry/Evaluation are
 * ever consulted.
 */
class InvalidAssignmentError extends PermissionAssignmentError {
  /**
   * @param {string} message
   * @param {object} [metadata]
   */
  constructor(message, metadata = {}) {
    super(`[Assignment] ${message}`, 'ASSIGNMENT_INVALID_REQUEST', metadata);
    this.name = 'InvalidAssignmentError';
    Error.captureStackTrace?.(this, InvalidAssignmentError);
  }
}

/**
 * Thrown when a well-formed assignment request names a Permission that
 * cannot be granted right now — because it does not exist, because
 * Evaluation reports it is not currently evaluable, or because the
 * internal Assignment Policy (../permission.assignment.policy.js)
 * reports its lifecycle status is not one Assignment grants against.
 * Deliberately NOT based on an Evaluation Allow/Deny outcome — see
 * permission.assignment.policy.js's header for why grantability and
 * authorization are kept as separate questions.
 */
class PermissionNotAssignableError extends PermissionAssignmentError {
  /**
   * @param {string} permissionIdentity
   * @param {string} reason
   * @param {object} [metadata]
   */
  constructor(permissionIdentity, reason, metadata = {}) {
    super(
      `[Assignment] Permission "${permissionIdentity}" is not assignable: ${reason}`,
      'ASSIGNMENT_PERMISSION_NOT_ASSIGNABLE',
      { permissionIdentity, reason, ...metadata },
    );
    this.name = 'PermissionNotAssignableError';
    Error.captureStackTrace?.(this, PermissionNotAssignableError);
  }
}

module.exports = {
  PermissionAssignmentError,
  DuplicateAssignmentError,
  AssignmentNotFoundError,
  InvalidAssignmentError,
  PermissionNotAssignableError,
};
