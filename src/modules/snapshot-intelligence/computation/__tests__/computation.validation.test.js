'use strict';

/**
 * @file core/src/modules/snapshot-intelligence/computation/__tests__/computation.validation.test.js
 * KR-02C — Snapshot Computation Engine — Validation tests.
 */

const {
  validateComputationInput,
  validateComputationSnapshots,
  validateComputationSnapshot,
  validateSnapshotComputationContext,
  validateComputationParameters,
} = require('../validation/snapshot.computation.validation');
const { SnapshotComputationValidationError } = require('../errors/snapshot.computation.errors');
const { buildComputationSnapshots, buildComputationContext } = require('../testHelpers/computation.fixtures');

describe('validateComputationSnapshots', () => {
  it('accepts a non-empty array of valid Snapshot entities', () => {
    expect(() => validateComputationSnapshots(buildComputationSnapshots(2))).not.toThrow();
  });

  it('rejects a non-array', () => {
    expect(() => validateComputationSnapshots({})).toThrow(SnapshotComputationValidationError);
  });

  it('rejects an empty array', () => {
    expect(() => validateComputationSnapshots([])).toThrow(SnapshotComputationValidationError);
  });

  it('reuses domain validation and re-wraps a domain validation failure', () => {
    expect(() => validateComputationSnapshot({ not: 'a snapshot' }, 0))
      .toThrow(SnapshotComputationValidationError);
    try {
      validateComputationSnapshot({ not: 'a snapshot' }, 3);
    } catch (err) {
      expect(err.metadata.index).toBe(3);
      expect(err.metadata.cause).toBeDefined();
      expect(err.metadata.cause.name).toBe('SnapshotValidationError');
    }
  });
});

describe('validateSnapshotComputationContext', () => {
  it('accepts a valid context shape', () => {
    expect(() => validateSnapshotComputationContext({
      options: {}, scope: 'resume', parameters: {}, executedAt: '2026-01-01T00:00:00.000Z',
    })).not.toThrow();
  });

  it('rejects a missing scope', () => {
    expect(() => validateSnapshotComputationContext({
      options: {}, parameters: {}, executedAt: '2026-01-01T00:00:00.000Z',
    })).toThrow(SnapshotComputationValidationError);
  });

  it('rejects a non-ISO executedAt', () => {
    expect(() => validateSnapshotComputationContext({
      options: {}, scope: 'resume', parameters: {}, executedAt: 'nope',
    })).toThrow(SnapshotComputationValidationError);
  });
});

describe('validateComputationParameters', () => {
  it('accepts a plain object', () => {
    expect(() => validateComputationParameters({ threshold: 5 })).not.toThrow();
  });

  it('rejects a non-object', () => {
    expect(() => validateComputationParameters(null)).toThrow(SnapshotComputationValidationError);
  });
});

describe('validateComputationInput', () => {
  it('accepts snapshots whose scope matches the context scope', () => {
    const snapshots = buildComputationSnapshots(2, 'resume');
    const context = buildComputationContext({ scope: 'resume' });
    expect(() => validateComputationInput(snapshots, context)).not.toThrow();
  });

  it('rejects snapshots whose scope does not match the context scope', () => {
    const snapshots = buildComputationSnapshots(1, 'resume');
    const context = buildComputationContext({ scope: 'skills' });
    expect(() => validateComputationInput(snapshots, context)).toThrow(SnapshotComputationValidationError);
  });
});
