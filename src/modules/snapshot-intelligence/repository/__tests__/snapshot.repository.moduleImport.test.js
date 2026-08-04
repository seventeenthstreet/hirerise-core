'use strict';

/**
 * @file repository/__tests__/snapshot.repository.moduleImport.test.js
 * KR-02B-01 — Snapshot Repository Foundation — module scaffold tests
 */

describe('repository module scaffold', () => {
  it('every repository submodule requires cleanly on its own', () => {
    expect(() => require('../errors/snapshot.repository.errors')).not.toThrow();
    expect(() => require('../dto/snapshot.repository.dto')).not.toThrow();
    expect(() => require('../mapping/snapshot.repository.mapper')).not.toThrow();
    expect(() => require('../validation/snapshot.repository.validation')).not.toThrow();
    expect(() => require('../contracts/snapshot.repository.contracts')).not.toThrow();
    expect(() => require('../interfaces/snapshot.repository.interfaces')).not.toThrow();
    expect(() => require('../inMemory/InMemorySnapshotRepository')).not.toThrow();
  });

  it('the repository barrel exposes the reference implementation and the interfaces', () => {
    // eslint-disable-next-line global-require
    const repository = require('../index');
    expect(typeof repository.InMemorySnapshotRepository).toBe('function');
    expect(typeof repository.SnapshotRepository).toBe('function');
    expect(typeof repository.SnapshotReadRepository).toBe('function');
    expect(typeof repository.SnapshotWriteRepository).toBe('function');
    expect(typeof repository.validation.assertRepositoryContractCompliance).toBe('function');
  });

  it('the module-level entry point exposes both domain and repository layers', () => {
    // eslint-disable-next-line global-require
    const snapshotIntelligence = require('../../index');
    expect(snapshotIntelligence.domain).toBeDefined();
    expect(typeof snapshotIntelligence.domain.createSnapshot).toBe('function');
    expect(snapshotIntelligence.repository).toBeDefined();
    expect(typeof snapshotIntelligence.repository.InMemorySnapshotRepository).toBe('function');
  });
});
