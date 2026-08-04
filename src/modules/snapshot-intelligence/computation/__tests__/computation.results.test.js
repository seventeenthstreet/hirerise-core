'use strict';

/**
 * @file core/src/modules/snapshot-intelligence/computation/__tests__/computation.results.test.js
 * KR-02C — Snapshot Computation Engine — Computation Result tests.
 */

const {
  createSnapshotComputationResult,
  createSnapshotComputationSummary,
  createSnapshotComputationStatistics,
  createSnapshotComputationDiagnostics,
  SnapshotComputationStatus,
} = require('../results/snapshot.computation.results');
const { SnapshotComputationValidationError } = require('../errors/snapshot.computation.errors');
const { buildComputationContext } = require('../testHelpers/computation.fixtures');

describe('createSnapshotComputationDiagnostics', () => {
  it('builds a valid frozen diagnostics object with defaults', () => {
    const diagnostics = createSnapshotComputationDiagnostics();
    expect(diagnostics.ruleErrors).toEqual([]);
    expect(diagnostics.notes).toEqual([]);
    expect(diagnostics.rulesConsidered).toBe(0);
    expect(Object.isFrozen(diagnostics)).toBe(true);
  });

  it('rejects a non-array ruleErrors', () => {
    expect(() => createSnapshotComputationDiagnostics({ ruleErrors: 'nope' }))
      .toThrow(SnapshotComputationValidationError);
  });

  it('rejects negative counts', () => {
    expect(() => createSnapshotComputationDiagnostics({ rulesFailed: -1 }))
      .toThrow(SnapshotComputationValidationError);
  });
});

describe('createSnapshotComputationStatistics', () => {
  it('builds a valid frozen statistics object with defaults', () => {
    const statistics = createSnapshotComputationStatistics();
    expect(statistics.inputCount).toBe(0);
    expect(statistics.counts).toEqual({});
    expect(Object.isFrozen(statistics)).toBe(true);
    expect(Object.isFrozen(statistics.counts)).toBe(true);
  });

  it('rejects a non-integer inputCount', () => {
    expect(() => createSnapshotComputationStatistics({ inputCount: 1.5 }))
      .toThrow(SnapshotComputationValidationError);
  });
});

describe('createSnapshotComputationSummary', () => {
  it('builds a valid frozen summary', () => {
    const summary = createSnapshotComputationSummary({
      scope: 'resume',
      status: SnapshotComputationStatus.COMPLETED,
      ruleCount: 2,
      groups: { EVALUATED: 2 },
    });
    expect(summary.scope).toBe('resume');
    expect(summary.status).toBe('COMPLETED');
    expect(Object.isFrozen(summary)).toBe(true);
  });

  it('rejects an invalid status', () => {
    expect(() => createSnapshotComputationSummary({
      scope: 'resume',
      status: 'NOT_A_STATUS',
    })).toThrow(SnapshotComputationValidationError);
  });

  it('rejects a missing scope', () => {
    expect(() => createSnapshotComputationSummary({
      status: SnapshotComputationStatus.COMPLETED,
    })).toThrow(SnapshotComputationValidationError);
  });
});

describe('createSnapshotComputationResult', () => {
  it('builds a valid, deeply frozen result', () => {
    const context = buildComputationContext();
    const summary = createSnapshotComputationSummary({ scope: 'resume', status: SnapshotComputationStatus.COMPLETED });
    const statistics = createSnapshotComputationStatistics({ inputCount: 1 });
    const diagnostics = createSnapshotComputationDiagnostics();

    const result = createSnapshotComputationResult({
      value: [{ ruleId: 'r1', value: 42 }],
      summary,
      statistics,
      diagnostics,
      context,
    });

    expect(result.value).toEqual([{ ruleId: 'r1', value: 42 }]);
    expect(result.summary).toBe(summary);
    expect(result.statistics).toBe(statistics);
    expect(result.diagnostics).toBe(diagnostics);
    expect(result.context).toBe(context);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.value)).toBe(true);
  });

  it('rejects a result missing a required member', () => {
    expect(() => createSnapshotComputationResult({ value: 1 }))
      .toThrow(SnapshotComputationValidationError);
  });

  it('attempting to mutate a result field throws', () => {
    const context = buildComputationContext();
    const result = createSnapshotComputationResult({
      value: 1,
      summary: createSnapshotComputationSummary({ scope: 'resume', status: SnapshotComputationStatus.COMPLETED }),
      statistics: createSnapshotComputationStatistics(),
      diagnostics: createSnapshotComputationDiagnostics(),
      context,
    });
    expect(() => {
      result.value = 2;
    }).toThrow(TypeError);
  });
});
