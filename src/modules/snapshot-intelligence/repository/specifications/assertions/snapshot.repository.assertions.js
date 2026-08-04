'use strict';

/**
 * @file core/src/modules/snapshot-intelligence/repository/specifications/assertions/snapshot.repository.assertions.js
 *
 * KR-02B-03A — Snapshot Repository Behavioral Specification Suite
 *
 * Reusable assertion helpers shared across specification files, so a
 * given behavioral check (e.g. "is this write idempotent?") has exactly
 * one implementation instead of being re-derived, slightly differently,
 * in every spec that needs it. Every assertion here operates on plain
 * values already returned by a repository (DTOs, promises, arrays) — it
 * never inspects a repository's internals, per the "validate WHAT, not
 * HOW" philosophy this suite follows throughout.
 *
 * These helpers assume they run inside a Jest test (they call the global
 * `expect`), matching how every other test file in this codebase is
 * written.
 */

/* global expect */

const { assertRepositoryContractCompliance } = require('../../contracts/snapshot.repository.contracts');

/**
 * Asserts that `implementation` exposes every method the certified
 * SnapshotRepository contract requires. This is a WHAT-level check (does
 * the shape satisfy the contract callers depend on?), not a HOW-level
 * check — it never inspects how a method is implemented.
 *
 * @param {object} implementation
 */
function assertRepositoryContractShape(implementation) {
  expect(() => assertRepositoryContractCompliance(implementation, 'SnapshotRepository')).not.toThrow();
}

/**
 * Asserts that a value returned by a write/read operation carries every
 * field that was in the corresponding create DTO, unchanged. Used to
 * verify the "repository invariants" and "write consistency" behaviors:
 * a repository must never silently drop or alter what it was given.
 *
 * @param {object} readDTO
 * @param {object} createDTO
 */
function assertRepositoryInvariant(readDTO, createDTO) {
  expect(readDTO.id).toBe(createDTO.id);
  expect(readDTO.subject).toEqual(createDTO.subject);
  expect(readDTO.scope).toBe(createDTO.scope);
  expect(readDTO.version).toEqual(createDTO.version);
  expect(readDTO.lifecycle).toBe(createDTO.lifecycle);
  expect(readDTO.supersessionState).toBe(createDTO.supersessionState);
}

/**
 * Asserts that two results represent the same underlying record —
 * i.e. a read is deterministic: calling it twice with no write in
 * between yields structurally identical output.
 *
 * @param {object} first
 * @param {object} second
 */
function assertDeterministicRead(first, second) {
  expect(second).toEqual(first);
}

/**
 * Asserts that a second write() of the same logical record (structurally
 * identical DTO) is an idempotent replay: it succeeds and returns a
 * result identical to the first write, rather than erroring or creating
 * a second record.
 *
 * @param {object} firstWriteResult
 * @param {object} secondWriteResult
 */
function assertIdempotentWrite(firstWriteResult, secondWriteResult) {
  expect(secondWriteResult).toEqual(firstWriteResult);
}

/**
 * Asserts that a promise rejects with the given error class — used for
 * append-only enforcement (remove() must always reject), duplicate
 * detection (conflicting write() must reject), and similar
 * "this operation is refused" behaviors.
 *
 * @param {Promise<any>} promise
 * @param {Function} ErrorClass
 */
async function assertRejectsWith(promise, ErrorClass) {
  await expect(promise).rejects.toThrow(ErrorClass);
}

/**
 * Asserts append-only enforcement specifically: the rejected operation
 * must not have mutated the store. Callers pass a re-fetch of the
 * targeted record taken *after* the rejected operation; it must still
 * be present (or still equal to whatever it was before), proving the
 * rejection had no side effect.
 *
 * @param {object|null} recordAfterRejection
 * @param {object|null} expectedUnchangedRecord
 */
function assertNoSideEffectFromRejection(recordAfterRejection, expectedUnchangedRecord) {
  expect(recordAfterRejection).toEqual(expectedUnchangedRecord);
}

/**
 * Asserts that mutating a value returned by a read operation does not
 * affect what the repository subsequently returns — i.e. reads hand
 * back copies, never live references into the store.
 *
 * @param {object} mutatedReadResult - the object the caller already mutated.
 * @param {object} freshReadResult - a brand-new read of the same record.
 * @param {string} mutatedField - the field name that was mutated.
 */
function assertNoMutationLeak(mutatedReadResult, freshReadResult, mutatedField) {
  expect(freshReadResult[mutatedField]).not.toBe(mutatedReadResult[mutatedField]);
}

/**
 * Asserts a list of read DTOs is ordered by ascending version number —
 * the certified ordering guarantee for listBySubject().
 *
 * @param {object[]} records
 */
function assertVersionOrdering(records) {
  const versions = records.map((record) => record.version.version);
  const sorted = [...versions].sort((a, b) => a - b);
  expect(versions).toEqual(sorted);
}

/**
 * Asserts that `record` is the expected "latest" result: present,
 * matching the expected id, and not in a SUPERSEDED supersession state
 * (per the certified findLatest() contract, which must exclude
 * superseded records).
 *
 * @param {object|null} record
 * @param {string} expectedId
 */
function assertLatestVersion(record, expectedId) {
  expect(record).not.toBeNull();
  expect(record.id).toBe(expectedId);
  expect(record.supersessionState).not.toBe('SUPERSEDED');
}

module.exports = {
  assertRepositoryContractShape,
  assertRepositoryInvariant,
  assertDeterministicRead,
  assertIdempotentWrite,
  assertRejectsWith,
  assertNoSideEffectFromRejection,
  assertNoMutationLeak,
  assertVersionOrdering,
  assertLatestVersion,
};
