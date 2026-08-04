'use strict';

/**
 * @file core/src/modules/snapshot-intelligence/computation/__tests__/computation.context.test.js
 * KR-02C — Snapshot Computation Engine — Computation Context tests.
 */

const { createSnapshotComputationContext } = require('../context/snapshot.computation.context');
const { SnapshotComputationValidationError } = require('../errors/snapshot.computation.errors');
const { buildComputationContext } = require('../testHelpers/computation.fixtures');

describe('createSnapshotComputationContext', () => {
  it('builds a valid, frozen context', () => {
    const context = buildComputationContext();
    expect(context.scope).toBe('resume');
    expect(context.executedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.options)).toBe(true);
    expect(Object.isFrozen(context.parameters)).toBe(true);
  });

  it('defaults options and parameters to empty objects', () => {
    const context = createSnapshotComputationContext({
      scope: 'resume',
      executedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(context.options).toEqual({});
    expect(context.parameters).toEqual({});
  });

  it('throws SnapshotComputationValidationError when scope is missing', () => {
    expect(() => createSnapshotComputationContext({
      executedAt: '2026-01-01T00:00:00.000Z',
    })).toThrow(SnapshotComputationValidationError);
  });

  it('throws when executedAt is not a valid ISO timestamp', () => {
    expect(() => createSnapshotComputationContext({
      scope: 'resume',
      executedAt: 'not-a-date',
    })).toThrow(SnapshotComputationValidationError);
  });

  it('throws when options is not an object', () => {
    expect(() => createSnapshotComputationContext({
      scope: 'resume',
      executedAt: '2026-01-01T00:00:00.000Z',
      options: 'nope',
    })).toThrow(SnapshotComputationValidationError);
  });

  it('is immutable — attempting to reassign a field throws in strict mode', () => {
    const context = buildComputationContext();
    expect(() => {
      context.scope = 'other';
    }).toThrow(TypeError);
  });

  it('never reads the wall clock — identical input always produces a deep-equal context', () => {
    const a = buildComputationContext();
    const b = buildComputationContext();
    expect(a).toEqual(b);
  });
});
