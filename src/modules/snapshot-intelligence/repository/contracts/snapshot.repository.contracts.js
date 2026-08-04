'use strict';

/**
 * @file core/src/modules/snapshot-intelligence/repository/contracts/snapshot.repository.contracts.js
 *
 * KR-02B-01 — Snapshot Repository Foundation
 *
 * Repository contract definitions, per KR-02B-01's requirement that
 * "these interfaces shall satisfy and extend the reserved Repository
 * Contracts defined in domain/contracts/snapshot.contracts.js".
 *
 * The certified domain layer already reserves a minimal
 * `SnapshotRepositoryContract` (write / findById / findLatest /
 * listBySubject) — see domain/contracts/snapshot.contracts.js, "REPOSITORY
 * CONTRACTS" section. This module documents the fuller three-way split
 * KR-02B-01 calls for (SnapshotReadRepository / SnapshotWriteRepository /
 * SnapshotRepository) as JSDoc-only contract shapes — consistent with
 * this repository's existing "JSDoc typedef, not TypeScript interface"
 * convention — and provides a small runtime helper,
 * `assertRepositoryContractCompliance`, so a repository implementation
 * (in-memory today, a real adapter later) can be checked against the
 * contract at wiring time rather than only at the type-checking level.
 *
 * REPOSITORY_CONTRACT_VERSIONS mirrors the certified domain layer's
 * CONTRACT_VERSIONS convention (domain/contracts/snapshot.contracts.js)
 * so later milestones have a single place to check compatibility.
 */

const { SnapshotRepositoryContractViolationError } = require('../errors/snapshot.repository.errors');

const REPOSITORY_CONTRACT_VERSIONS = Object.freeze({
  read: 1,
  write: 1,
  repository: 1,
});

/**
 * @callback SnapshotReadRepositoryFindById
 * @param {import('../../domain/types/snapshot.types').SnapshotIdentifier} id
 * @returns {Promise<import('../dto/snapshot.repository.dto').SnapshotReadDTO|null>}
 */

/**
 * @callback SnapshotReadRepositoryFindLatest
 * @param {import('../../domain/types/snapshot.types').SubjectReference} subject
 * @param {string} [scope]
 * @returns {Promise<import('../dto/snapshot.repository.dto').SnapshotReadDTO|null>} -
 * must exclude snapshots whose supersessionState is SUPERSEDED, per the
 * certified domain contract this extends.
 */

/**
 * @callback SnapshotReadRepositoryListBySubject
 * @param {import('../../domain/types/snapshot.types').SubjectReference} subject
 * @param {string} [scope]
 * @returns {Promise<import('../dto/snapshot.repository.dto').SnapshotReadDTO[]>}
 */

/**
 * @typedef {Object} SnapshotReadRepository - Read-only repository
 * abstraction. Satisfies the findById/findLatest/listBySubject members of
 * the certified domain SnapshotRepositoryContract.
 * @property {SnapshotReadRepositoryFindById} findById
 * @property {SnapshotReadRepositoryFindLatest} findLatest
 * @property {SnapshotReadRepositoryListBySubject} listBySubject
 */

/**
 * @callback SnapshotWriteRepositoryWrite
 * @param {import('../dto/snapshot.repository.dto').SnapshotCreateDTO} dto
 * @returns {Promise<import('../dto/snapshot.repository.dto').SnapshotReadDTO>} -
 * must be idempotent under replay of the same SnapshotIdentifier per the
 * certified domain contract (replay = write() called again with an
 * identical DTO for an id that already exists succeeds and returns the
 * existing record unchanged; write() called with a *different* DTO for
 * an existing id is a conflict, not a replay — see SnapshotDuplicateError).
 */

/**
 * @callback SnapshotWriteRepositoryUpdate
 * @param {import('../dto/snapshot.repository.dto').SnapshotUpdateDTO} dto
 * @returns {Promise<import('../dto/snapshot.repository.dto').SnapshotReadDTO>} -
 * lifecycle/supersession-state transition only; see
 * ../dto/snapshot.repository.dto.js file header.
 */

/**
 * @callback SnapshotWriteRepositoryRemove
 * @param {import('../dto/snapshot.repository.dto').SnapshotDeleteDTO} dto
 * @returns {Promise<never>} - always rejects with
 * SnapshotOperationNotSupportedError; see
 * ../dto/snapshot.repository.dto.js file header.
 */

/**
 * @typedef {Object} SnapshotWriteRepository - Write-only repository
 * abstraction. Satisfies the write member of the certified domain
 * SnapshotRepositoryContract.
 * @property {SnapshotWriteRepositoryWrite} write
 * @property {SnapshotWriteRepositoryUpdate} update
 * @property {SnapshotWriteRepositoryRemove} remove
 */

/**
 * @typedef {SnapshotReadRepository & SnapshotWriteRepository} SnapshotRepository
 * - Canonical repository abstraction combining read and write. This is
 * the shape that satisfies the certified domain SnapshotRepositoryContract
 * in full (write, findById, findLatest, listBySubject) while also
 * exposing the additional update/remove members KR-02B-01 defines.
 */

const READ_REPOSITORY_METHODS = Object.freeze(['findById', 'findLatest', 'listBySubject']);
const WRITE_REPOSITORY_METHODS = Object.freeze(['write', 'update', 'remove']);
const REPOSITORY_METHODS = Object.freeze([...READ_REPOSITORY_METHODS, ...WRITE_REPOSITORY_METHODS]);

const CONTRACT_METHOD_REGISTRY = Object.freeze({
  SnapshotReadRepository: READ_REPOSITORY_METHODS,
  SnapshotWriteRepository: WRITE_REPOSITORY_METHODS,
  SnapshotRepository: REPOSITORY_METHODS,
});

/**
 * Asserts that `implementation` exposes every method a named contract
 * requires as a function. Used at wiring time (and by the certified test
 * suite) to catch a mis-implemented adapter before it is handed to a
 * caller, per KR-02B-01's "Repository contract compliance" validation
 * deliverable.
 *
 * @param {object} implementation
 * @param {'SnapshotReadRepository'|'SnapshotWriteRepository'|'SnapshotRepository'} contractName
 * @throws {SnapshotRepositoryContractViolationError}
 */
function assertRepositoryContractCompliance(implementation, contractName) {
  const requiredMethods = CONTRACT_METHOD_REGISTRY[contractName];
  if (!requiredMethods) {
    throw new SnapshotRepositoryContractViolationError(
      `Unknown repository contract "${contractName}"`,
      { contractName },
    );
  }
  if (typeof implementation !== 'object' || implementation === null) {
    throw new SnapshotRepositoryContractViolationError(
      `Repository implementation for "${contractName}" must be an object`,
      { contractName },
    );
  }
  const missing = requiredMethods.filter((method) => typeof implementation[method] !== 'function');
  if (missing.length > 0) {
    throw new SnapshotRepositoryContractViolationError(
      `Repository implementation does not satisfy "${contractName}": missing method(s) ${missing.join(', ')}`,
      { contractName, missing },
    );
  }
}

module.exports = {
  REPOSITORY_CONTRACT_VERSIONS,
  READ_REPOSITORY_METHODS,
  WRITE_REPOSITORY_METHODS,
  REPOSITORY_METHODS,
  CONTRACT_METHOD_REGISTRY,
  assertRepositoryContractCompliance,
};
