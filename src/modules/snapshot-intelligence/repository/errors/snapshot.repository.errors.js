'use strict';

/**
 * @file core/src/modules/snapshot-intelligence/repository/errors/snapshot.repository.errors.js
 *
 * KR-02B-01 — Snapshot Repository Foundation
 *
 * Named error classes for the Snapshot Repository boundary, following the
 * same standalone-hierarchy convention established by the certified
 * domain layer (domain/errors/snapshot.errors.js): a base class carrying
 * a machine-readable `code` and free-form `metadata`, with named
 * subclasses for every distinct failure mode a repository consumer needs
 * to branch on.
 *
 * These errors are deliberately infrastructure-neutral. Per KR-02B-01's
 * "Explicit Constraints" and "Do not expose infrastructure exceptions",
 * no adapter (in-memory, and later Supabase/Postgres/etc.) may leak a
 * driver-specific exception across the repository boundary — every
 * adapter must catch its own infrastructure errors and re-throw one of
 * the classes below instead. The in-memory reference implementation in
 * ../inMemory/InMemorySnapshotRepository.js follows this rule even though
 * it has no real infrastructure to fail, so that future adapters have a
 * concrete example to match.
 *
 * SnapshotRepositoryError is never thrown directly — always one of the
 * named subclasses.
 */

class SnapshotRepositoryError extends Error {
  /**
   * @param {string} message
   * @param {string} code - machine-readable error code
   * @param {object} [metadata]
   */
  constructor(message, code, metadata = {}) {
    super(message);
    this.name = 'SnapshotRepositoryError';
    this.code = code;
    this.metadata = metadata;
    Error.captureStackTrace?.(this, SnapshotRepositoryError);
  }
}

/**
 * Thrown when a lookup (findById, findLatest, etc.) is asked to resolve a
 * Snapshot that does not exist in the repository. Read operations that
 * are documented to return `null` on a miss (per the certified
 * SnapshotRepositoryContract's findById/findLatest) do NOT throw this —
 * it is reserved for operations where "not found" is an error condition
 * for the caller (e.g. an explicit `getOrThrow`-style helper, or a write
 * operation that requires an existing record).
 */
class SnapshotNotFoundError extends SnapshotRepositoryError {
  constructor(message, metadata = {}) {
    super(message, 'SNAPSHOT_NOT_FOUND', metadata);
    this.name = 'SnapshotNotFoundError';
  }
}

/**
 * Thrown when a write operation's expected version/state does not match
 * what the repository currently holds — the optimistic-locking / conflict
 * signal every future adapter (KR-02B-02+) is expected to raise under the
 * same conditions. KR-02B-01's in-memory implementation raises this for
 * the one conflict case in scope: a write() naming a snapshot id that
 * already exists (see SnapshotDuplicateError note below for why writes
 * are conflict-checked rather than silently upserting).
 */
class SnapshotConflictError extends SnapshotRepositoryError {
  constructor(message, metadata = {}) {
    super(message, 'SNAPSHOT_CONFLICT', metadata);
    this.name = 'SnapshotConflictError';
  }
}

/**
 * Thrown when a repository DTO or operation argument fails
 * repository-layer validation (shape, identifier format, contract
 * compliance). Deliberately distinct from the domain layer's
 * SnapshotValidationError (domain/errors/snapshot.errors.js) — that class
 * guards entity construction; this one guards the repository boundary
 * (DTOs, lookup arguments, pagination-free filter shapes) and is never
 * thrown from inside a domain entity factory.
 */
class SnapshotRepositoryValidationError extends SnapshotRepositoryError {
  constructor(message, metadata = {}) {
    super(message, 'SNAPSHOT_REPOSITORY_VALIDATION_ERROR', metadata);
    this.name = 'SnapshotRepositoryValidationError';
  }
}

/**
 * Thrown when a write operation attempts to create a Snapshot whose
 * identifier already exists in the repository. Per KR-01B's Historical
 * Truth / append-only principle, a repository write is a create-only
 * operation for a given SnapshotIdentifier — there is no in-place update
 * path (see SnapshotUpdateDTO's documentation in ../dto for how
 * lifecycle transitions are represented instead). Attempting to write the
 * same id twice is therefore always a caller error, not an upsert.
 */
class SnapshotDuplicateError extends SnapshotRepositoryError {
  constructor(message, metadata = {}) {
    super(message, 'SNAPSHOT_DUPLICATE', metadata);
    this.name = 'SnapshotDuplicateError';
  }
}

/**
 * Thrown when an implementation of SnapshotRepository / ReadRepository /
 * WriteRepository does not satisfy the required method surface — see
 * ../contracts/snapshot.repository.contracts.js's
 * `assertRepositoryContractCompliance`. This is a programming-time /
 * wiring error (a mis-implemented adapter), not a runtime data error.
 */
class SnapshotRepositoryContractViolationError extends SnapshotRepositoryError {
  constructor(message, metadata = {}) {
    super(message, 'SNAPSHOT_REPOSITORY_CONTRACT_VIOLATION', metadata);
    this.name = 'SnapshotRepositoryContractViolationError';
  }
}

/**
 * Thrown when a caller attempts an operation this milestone's scope
 * explicitly excludes (e.g. mutating a Snapshot's preserved content, or
 * a hard delete of a historical record). Distinguishes "not supported by
 * design" from SnapshotRepositoryContractViolationError ("not supported
 * because the adapter is broken") and from SnapshotRepositoryValidationError
 * ("not supported because the input is malformed").
 */
class SnapshotOperationNotSupportedError extends SnapshotRepositoryError {
  constructor(message, metadata = {}) {
    super(message, 'SNAPSHOT_OPERATION_NOT_SUPPORTED', metadata);
    this.name = 'SnapshotOperationNotSupportedError';
  }
}

module.exports = {
  SnapshotRepositoryError,
  SnapshotNotFoundError,
  SnapshotConflictError,
  SnapshotRepositoryValidationError,
  SnapshotDuplicateError,
  SnapshotRepositoryContractViolationError,
  SnapshotOperationNotSupportedError,
};
