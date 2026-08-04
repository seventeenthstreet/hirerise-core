'use strict';

/**
 * @file repository/__tests__/snapshot.repository.contracts.test.js
 * KR-02B-01 — Snapshot Repository Foundation — contract compliance tests
 */

const {
  assertRepositoryContractCompliance,
  CONTRACT_METHOD_REGISTRY,
  REPOSITORY_CONTRACT_VERSIONS,
} = require('../contracts/snapshot.repository.contracts');
const { SnapshotRepositoryContractViolationError } = require('../errors/snapshot.repository.errors');
const { InMemorySnapshotRepository } = require('../inMemory/InMemorySnapshotRepository');
const domainContracts = require('../../domain/contracts/snapshot.contracts');

describe('assertRepositoryContractCompliance', () => {
  it('passes for the in-memory reference implementation against all three contracts', () => {
    const repo = new InMemorySnapshotRepository();
    expect(() => assertRepositoryContractCompliance(repo, 'SnapshotReadRepository')).not.toThrow();
    expect(() => assertRepositoryContractCompliance(repo, 'SnapshotWriteRepository')).not.toThrow();
    expect(() => assertRepositoryContractCompliance(repo, 'SnapshotRepository')).not.toThrow();
  });

  it('rejects an implementation missing a required method', () => {
    const incomplete = { findById: async () => null, listBySubject: async () => [] };
    expect(() => assertRepositoryContractCompliance(incomplete, 'SnapshotReadRepository'))
      .toThrow(SnapshotRepositoryContractViolationError);
  });

  it('rejects a non-object implementation', () => {
    expect(() => assertRepositoryContractCompliance(null, 'SnapshotRepository'))
      .toThrow(SnapshotRepositoryContractViolationError);
  });

  it('rejects an unknown contract name', () => {
    expect(() => assertRepositoryContractCompliance({}, 'NotARealContract'))
      .toThrow(SnapshotRepositoryContractViolationError);
  });

  it('the SnapshotRepository contract superset covers every certified-domain-reserved method', () => {
    // The certified domain contract (domain/contracts/snapshot.contracts.js)
    // reserves write/findById/findLatest/listBySubject for KR-02B's
    // SnapshotRepository. Every one of those must appear in the fuller
    // contract this milestone defines.
    const reservedMethods = ['write', 'findById', 'findLatest', 'listBySubject'];
    reservedMethods.forEach((method) => {
      expect(CONTRACT_METHOD_REGISTRY.SnapshotRepository).toContain(method);
    });
    // sanity: the domain contract module itself still loads cleanly and
    // still exposes CONTRACT_VERSIONS (KR-02A artifact left unchanged).
    expect(domainContracts.CONTRACT_VERSIONS.repository).toBe(1);
  });

  it('exposes a REPOSITORY_CONTRACT_VERSIONS map for future compatibility checks', () => {
    expect(REPOSITORY_CONTRACT_VERSIONS).toEqual({ read: 1, write: 1, repository: 1 });
  });
});
