'use strict';

/**
 * @file core/src/modules/snapshot-intelligence/computation/__tests__/computation.errors.test.js
 * KR-02C — Snapshot Computation Engine — Error hierarchy tests.
 */

const {
  SnapshotComputationError,
  SnapshotComputationValidationError,
  SnapshotRuleExecutionError,
  SnapshotAggregationError,
  SnapshotPipelineCompositionError,
} = require('../errors/snapshot.computation.errors');

describe('computation error hierarchy', () => {
  const subclasses = [
    [SnapshotComputationValidationError, 'SNAPSHOT_COMPUTATION_VALIDATION_ERROR', 'SnapshotComputationValidationError'],
    [SnapshotRuleExecutionError, 'SNAPSHOT_RULE_EXECUTION_ERROR', 'SnapshotRuleExecutionError'],
    [SnapshotAggregationError, 'SNAPSHOT_AGGREGATION_ERROR', 'SnapshotAggregationError'],
    [SnapshotPipelineCompositionError, 'SNAPSHOT_PIPELINE_COMPOSITION_ERROR', 'SnapshotPipelineCompositionError'],
  ];

  subclasses.forEach(([ErrorClass, expectedCode, expectedName]) => {
    it(`${expectedName} extends SnapshotComputationError and Error`, () => {
      const err = new ErrorClass('boom', { field: 'x' });
      expect(err).toBeInstanceOf(SnapshotComputationError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe(expectedName);
      expect(err.code).toBe(expectedCode);
      expect(err.metadata).toEqual({ field: 'x' });
      expect(err.message).toBe('boom');
    });
  });

  it('SnapshotComputationError is infrastructure-neutral (no status/http fields)', () => {
    const err = new SnapshotComputationValidationError('bad input');
    expect(err.status).toBeUndefined();
    expect(err.statusCode).toBeUndefined();
    expect(err.httpStatus).toBeUndefined();
  });

  it('defaults metadata to an empty object', () => {
    const err = new SnapshotAggregationError('boom');
    expect(err.metadata).toEqual({});
  });
});
