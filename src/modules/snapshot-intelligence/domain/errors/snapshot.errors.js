'use strict';

/**
 * @file core-work/src/modules/snapshot-intelligence/domain/errors/snapshot.errors.js
 *
 * KR-02A — Snapshot Domain Foundation
 *
 * Named error classes for the Snapshot Intelligence domain boundary,
 * following the same standalone-hierarchy convention already established
 * by src/domain/studentProfile/studentProfile.errors.js: a pure domain
 * module with no HTTP awareness does not carry an HTTP-status-coupled
 * base class. Callers at a future HTTP or worker boundary (KR-02E, KR-02G)
 * are expected to translate these into their own boundary's error type.
 *
 * KR-02A only throws these from validation and construction code — there
 * is no persistence, computation, or I/O in this work package, so no
 * repository- or network-flavored error class is defined here. Later work
 * packages may extend this hierarchy but must not repurpose or redefine
 * the classes below.
 */

/**
 * Base class for every error this module throws. Never thrown directly —
 * always one of the named subclasses below.
 */
class SnapshotDomainError extends Error {
  /**
   * @param {string} message
   * @param {string} code - machine-readable error code
   * @param {object} [metadata]
   */
  constructor(message, code, metadata = {}) {
    super(message);
    this.name = 'SnapshotDomainError';
    this.code = code;
    this.metadata = metadata;
    Error.captureStackTrace?.(this, SnapshotDomainError);
  }
}

/**
 * Thrown when a domain entity or value object is constructed with a shape
 * that does not satisfy its validation schema.
 */
class SnapshotValidationError extends SnapshotDomainError {
  constructor(message, metadata = {}) {
    super(message, 'SNAPSHOT_VALIDATION_ERROR', metadata);
    this.name = 'SnapshotValidationError';
  }
}

/**
 * Thrown when code attempts to mutate a field on an already-constructed
 * (and therefore frozen) Snapshot Intelligence entity or value object.
 * Enforces KR-01B's Historical Truth principle ("snapshots are immutable")
 * at the domain layer rather than relying on discipline alone.
 */
class SnapshotImmutabilityViolationError extends SnapshotDomainError {
  constructor(message, metadata = {}) {
    super(message, 'SNAPSHOT_IMMUTABILITY_VIOLATION', metadata);
    this.name = 'SnapshotImmutabilityViolationError';
  }
}

/**
 * Thrown when a contract (DTO, read model, event payload, repository
 * contract, etc.) is asked to serialize or deserialize a shape it does
 * not recognize as one of its declared variants.
 */
class SnapshotContractError extends SnapshotDomainError {
  constructor(message, metadata = {}) {
    super(message, 'SNAPSHOT_CONTRACT_ERROR', metadata);
    this.name = 'SnapshotContractError';
  }
}

/**
 * Thrown when a reference (SubjectReference, EvidenceReference,
 * SignalReference, etc.) is constructed pointing at a domain or
 * capability outside what KR-02-R1's Architecture Freeze and KR-02-R1 §2
 * permit Snapshot Intelligence to observe.
 */
class SnapshotOwnershipViolationError extends SnapshotDomainError {
  constructor(message, metadata = {}) {
    super(message, 'SNAPSHOT_OWNERSHIP_VIOLATION', metadata);
    this.name = 'SnapshotOwnershipViolationError';
  }
}

module.exports = {
  SnapshotDomainError,
  SnapshotValidationError,
  SnapshotImmutabilityViolationError,
  SnapshotContractError,
  SnapshotOwnershipViolationError,
};
