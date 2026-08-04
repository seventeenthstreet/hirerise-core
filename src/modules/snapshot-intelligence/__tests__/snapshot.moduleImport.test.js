'use strict';

/**
 * @file core-work/src/modules/snapshot-intelligence/__tests__/snapshot.moduleImport.test.js
 * KR-02A — Snapshot Domain Foundation — Module import / scaffold tests
 *
 * Verifies the module scaffold itself: every file KR-02A's "Module
 * Scaffold" deliverable calls for is present and require()-able with no
 * circular-dependency or path errors, and the module's top-level entry
 * point exposes the domain layer.
 */

describe('module scaffold', () => {
  it('the module entry point requires cleanly and exposes the domain layer', () => {
    const snapshotIntelligenceModule = require('../index');
    expect(snapshotIntelligenceModule.domain).toBeDefined();
    expect(typeof snapshotIntelligenceModule.domain.createSnapshot).toBe('function');
  });

  it('every domain submodule requires cleanly on its own', () => {
    expect(() => require('../domain/entities/snapshot.entities')).not.toThrow();
    expect(() => require('../domain/value-objects/snapshot.valueObjects')).not.toThrow();
    expect(() => require('../domain/constants/snapshot.constants')).not.toThrow();
    expect(() => require('../domain/errors/snapshot.errors')).not.toThrow();
    expect(() => require('../domain/schemas/snapshot.validation')).not.toThrow();
    expect(() => require('../domain/schemas/snapshot.schema')).not.toThrow();
    expect(() => require('../domain/dto/snapshot.dto')).not.toThrow();
    expect(() => require('../domain/events/snapshot.eventContracts')).not.toThrow();
    expect(() => require('../domain/contracts/snapshot.contracts')).not.toThrow();
    expect(() => require('../domain/types/snapshot.types')).not.toThrow();
  });

  it('the types module exports an empty object (JSDoc-only, no runtime surface)', () => {
    // eslint-disable-next-line global-require
    const types = require('../domain/types/snapshot.types');
    expect(types).toEqual({});
  });
});
