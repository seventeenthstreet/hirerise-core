'use strict';

/**
 * @file core/src/modules/snapshot-intelligence/repository/validation/snapshot.repository.validation.js
 *
 * KR-02B-01 — Snapshot Repository Foundation
 *
 * Repository-boundary validation, per KR-02B-01's "Repository Validation"
 * deliverable: identifiers, DTO structure, repository contract
 * compliance, and operation arguments.
 *
 * This module explicitly does NOT duplicate domain validation
 * (KR-02B-01's "Do not duplicate domain validation" constraint). It only
 * validates concerns that exist at the repository boundary and have no
 * domain-layer equivalent:
 *   - identifier well-formedness for *lookup* arguments (the domain layer
 *     validates a SnapshotIdentifier's shape when constructing an entity;
 *     this module validates the same shape when a caller passes a bare
 *     id string into a read operation, before any entity is involved).
 *   - DTO structural validity — delegated to ../dto/snapshot.repository.dto.js,
 *     re-exported here so repository consumers have one module to import
 *     for every repository-layer validation need.
 *   - operation argument validity (e.g. subject-scoped queries).
 *   - repository contract compliance — delegated to
 *     ../contracts/snapshot.repository.contracts.js, re-exported here for
 *     the same reason.
 *
 * Every function here either returns void (valid) or throws
 * SnapshotRepositoryValidationError — never a domain error class.
 */

const { SnapshotRepositoryValidationError } = require('../errors/snapshot.repository.errors');
const {
  validateSnapshotCreateDTO,
  validateSnapshotUpdateDTO,
  validateSnapshotDeleteDTO,
  validateSnapshotLookupDTO,
} = require('../dto/snapshot.repository.dto');
const { assertRepositoryContractCompliance } = require('../contracts/snapshot.repository.contracts');

/**
 * Validates that a value is usable as a SnapshotIdentifier argument to a
 * read/write operation (non-empty string). Mirrors the shape the domain
 * layer's `validateSnapshotIdentifier` enforces, but is a repository-layer
 * check applied to a bare argument, not to an entity under construction.
 *
 * @param {unknown} id
 * @throws {SnapshotRepositoryValidationError}
 */
function validateRepositoryIdentifierArgument(id) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new SnapshotRepositoryValidationError(
      'Repository operation requires a non-empty string identifier',
      { id },
    );
  }
}

/**
 * Validates a SubjectReference argument to a subject-scoped operation
 * (findLatest, listBySubject). Structural check only (an object with
 * subjectType and subjectId) — full SubjectReference semantics are a
 * domain concern already enforced when the referenced Snapshot(s) were
 * constructed.
 *
 * @param {unknown} subject
 * @throws {SnapshotRepositoryValidationError}
 */
function validateRepositorySubjectArgument(subject) {
  if (typeof subject !== 'object' || subject === null || Array.isArray(subject)) {
    throw new SnapshotRepositoryValidationError(
      'Repository operation requires a SubjectReference object',
      { subject },
    );
  }
  if (typeof subject.subjectType !== 'string' || subject.subjectType.length === 0) {
    throw new SnapshotRepositoryValidationError(
      'SubjectReference.subjectType must be a non-empty string',
      { subject },
    );
  }
  if (typeof subject.subjectId !== 'string' || subject.subjectId.length === 0) {
    throw new SnapshotRepositoryValidationError(
      'SubjectReference.subjectId must be a non-empty string',
      { subject },
    );
  }
}

/**
 * Validates an optional scope argument (e.g. listBySubject's second
 * parameter): when present, must be a non-empty string.
 *
 * @param {unknown} scope
 * @throws {SnapshotRepositoryValidationError}
 */
function validateRepositoryScopeArgument(scope) {
  if (scope === undefined) return;
  if (typeof scope !== 'string' || scope.length === 0) {
    throw new SnapshotRepositoryValidationError(
      'Repository scope argument must be a non-empty string when provided',
      { scope },
    );
  }
}

module.exports = {
  validateRepositoryIdentifierArgument,
  validateRepositorySubjectArgument,
  validateRepositoryScopeArgument,
  // re-exported for a single validation entry point (see file header)
  validateSnapshotCreateDTO,
  validateSnapshotUpdateDTO,
  validateSnapshotDeleteDTO,
  validateSnapshotLookupDTO,
  assertRepositoryContractCompliance,
};
