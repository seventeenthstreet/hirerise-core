'use strict';

/**
 * @file core-work/src/modules/snapshot-intelligence/__tests__/snapshot.contracts.test.js
 * KR-02A — Snapshot Domain Foundation — Contract consistency tests
 */

const { CONTRACT_VERSIONS } = require('../domain/contracts/snapshot.contracts');
const { EVENT_TYPES } = require('../domain/events/snapshot.eventContracts');
const domain = require('../domain');

describe('CONTRACT_VERSIONS', () => {
  it('declares a version for every contract category KR-02A defines', () => {
    expect(CONTRACT_VERSIONS).toEqual({
      internal: 1,
      public: 1,
      worker: 1,
      repository: 1,
      event: 1,
      validation: 1,
    });
  });

  it('is frozen, so a later work package cannot silently bump a version', () => {
    expect(Object.isFrozen(CONTRACT_VERSIONS)).toBe(true);
  });
});

describe('EVENT_TYPES', () => {
  it('declares exactly the three producer events KR-02 §10.2 assigns to Snapshot Intelligence', () => {
    expect(Object.values(EVENT_TYPES).sort()).toEqual(
      ['recalculation-completed', 'snapshot-created', 'snapshot-superseded'].sort(),
    );
  });
});

describe('domain barrel export', () => {
  it('exposes every entity factory', () => {
    expect(typeof domain.createSnapshot).toBe('function');
    expect(typeof domain.createMoment).toBe('function');
    expect(typeof domain.createContextEnvelope).toBe('function');
  });

  it('exposes every enumeration', () => {
    expect(domain.MomentClassification).toBeDefined();
    expect(domain.SnapshotLifecycle).toBeDefined();
    expect(domain.SnapshotConsistencyState).toBeDefined();
  });

  it('exposes the schema registry and validation module', () => {
    expect(domain.SCHEMA_REGISTRY).toBeDefined();
    expect(typeof domain.validation.validateSnapshot).toBe('function');
  });

  it('exposes named error classes', () => {
    expect(domain.SnapshotValidationError).toBeDefined();
    expect(domain.SnapshotImmutabilityViolationError).toBeDefined();
  });
});
