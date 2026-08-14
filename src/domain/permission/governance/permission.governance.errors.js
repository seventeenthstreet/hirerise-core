'use strict';

/**
 * @file src/domain/permission/governance/permission.governance.errors.js
 *
 * WP-ADMIN-04F-04 — Enterprise Permission Governance Services
 *
 * Named error hierarchy for the Governance boundary, following the same
 * per-layer convention already established by the domain layer
 * (../permission.errors.js), the repository layer
 * (../repository/permission.repository.errors.js), and the registry layer
 * (../registry/permission.registry.errors.js). A Governance-layer error is
 * distinct from all three: it is never a domain shape problem (guaranteed
 * before a Permission reaches Governance), never a persistence problem
 * (Governance has no direct database access), and never a catalog-wide
 * consistency finding (that's Registry Validation) — it is specifically a
 * lifecycle-workflow problem: an illegal transition, a governance rule
 * violation, or a malformed governance request.
 */

class PermissionGovernanceError extends Error {
  /**
   * @param {string} message
   * @param {string} code - machine-readable error code
   * @param {object} [metadata]
   */
  constructor(message, code, metadata = {}) {
    super(message);
    this.name = 'PermissionGovernanceError';
    this.code = code;
    this.metadata = metadata;
    Error.captureStackTrace?.(this, PermissionGovernanceError);
  }
}

/**
 * Thrown when a requested lifecycle transition (AUTH-04 §6 Governance
 * Lifecycle) is not permitted from the Permission's current status —
 * either because it moves backward, skips stages, or departs from a
 * terminal stage.
 */
class InvalidLifecycleTransitionError extends PermissionGovernanceError {
  /**
   * @param {string} fromStatus
   * @param {string} toStatus
   * @param {object} [metadata]
   */
  constructor(fromStatus, toStatus, metadata = {}) {
    super(
      `[Governance] invalid lifecycle transition: ${fromStatus} -> ${toStatus}`,
      'GOVERNANCE_INVALID_LIFECYCLE_TRANSITION',
      { fromStatus, toStatus, ...metadata },
    );
    this.name = 'InvalidLifecycleTransitionError';
    Error.captureStackTrace?.(this, InvalidLifecycleTransitionError);
  }
}

/**
 * Thrown when a Publication transition is requested for a Permission that
 * has already been published.
 */
class PermissionAlreadyPublishedError extends PermissionGovernanceError {
  /**
   * @param {string} identity
   * @param {object} [metadata]
   */
  constructor(identity, metadata = {}) {
    super(
      `[Governance] Permission "${identity}" is already published`,
      'GOVERNANCE_PERMISSION_ALREADY_PUBLISHED',
      { identity, ...metadata },
    );
    this.name = 'PermissionAlreadyPublishedError';
    Error.captureStackTrace?.(this, PermissionAlreadyPublishedError);
  }
}

/**
 * Thrown when a Retirement transition is requested for a Permission that
 * has already been retired (Retired is a terminal stage, AUTH-04 §7).
 */
class PermissionAlreadyRetiredError extends PermissionGovernanceError {
  /**
   * @param {string} identity
   * @param {object} [metadata]
   */
  constructor(identity, metadata = {}) {
    super(
      `[Governance] Permission "${identity}" is already retired`,
      'GOVERNANCE_PERMISSION_ALREADY_RETIRED',
      { identity, ...metadata },
    );
    this.name = 'PermissionAlreadyRetiredError';
    Error.captureStackTrace?.(this, PermissionAlreadyRetiredError);
  }
}

/**
 * Thrown when a governance request itself is malformed — missing a
 * required argument, or carrying a value of the wrong shape — before any
 * lifecycle or rule evaluation is attempted.
 */
class GovernanceValidationError extends PermissionGovernanceError {
  /**
   * @param {string} message
   * @param {object} [metadata]
   */
  constructor(message, metadata = {}) {
    super(`[Governance] ${message}`, 'GOVERNANCE_VALIDATION_ERROR', metadata);
    this.name = 'GovernanceValidationError';
    Error.captureStackTrace?.(this, GovernanceValidationError);
  }
}

/**
 * Thrown when a governance rule is violated in a way that isn't a simple
 * lifecycle-transition problem — e.g. an attempt to change a Permission's
 * immutable Identity, a duplicate-identity conflict, a duplicate lifecycle
 * action (re-requesting a transition already applied), or a Registry
 * inconsistency discovered mid-operation.
 */
class GovernanceConflictError extends PermissionGovernanceError {
  /**
   * @param {string} message
   * @param {object} [metadata]
   */
  constructor(message, metadata = {}) {
    super(`[Governance] ${message}`, 'GOVERNANCE_CONFLICT_ERROR', metadata);
    this.name = 'GovernanceConflictError';
    Error.captureStackTrace?.(this, GovernanceConflictError);
  }
}

module.exports = {
  PermissionGovernanceError,
  InvalidLifecycleTransitionError,
  PermissionAlreadyPublishedError,
  PermissionAlreadyRetiredError,
  GovernanceValidationError,
  GovernanceConflictError,
};
