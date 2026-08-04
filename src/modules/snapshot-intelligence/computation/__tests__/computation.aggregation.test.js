'use strict';

/**
 * @file core/src/modules/snapshot-intelligence/computation/__tests__/computation.aggregation.test.js
 * KR-02C — Snapshot Computation Engine — Aggregation Framework tests.
 */

const {
  reduceValues,
  groupByKey,
  accumulate,
  summarize,
} = require('../aggregation/snapshot.computation.aggregation');
const { SnapshotAggregationError } = require('../errors/snapshot.computation.errors');

describe('reduceValues', () => {
  it('reduces items in order from a seed', () => {
    const total = reduceValues([1, 2, 3], (acc, item) => acc + item, 0);
    expect(total).toBe(6);
  });

  it('rejects a non-array', () => {
    expect(() => reduceValues('nope', (a) => a, 0)).toThrow(SnapshotAggregationError);
  });

  it('wraps a throwing reducer', () => {
    expect(() => reduceValues([1], () => { throw new Error('bad'); }, 0)).toThrow(SnapshotAggregationError);
  });
});

describe('groupByKey', () => {
  it('groups items by computed key, preserving relative order', () => {
    const groups = groupByKey(
      [{ status: 'A', n: 1 }, { status: 'B', n: 2 }, { status: 'A', n: 3 }],
      (item) => item.status,
    );
    expect(groups).toEqual({
      A: [{ status: 'A', n: 1 }, { status: 'A', n: 3 }],
      B: [{ status: 'B', n: 2 }],
    });
  });

  it('rejects a non-function keyFn', () => {
    expect(() => groupByKey([1, 2], null)).toThrow(SnapshotAggregationError);
  });

  it('wraps a throwing keyFn with the offending index', () => {
    try {
      groupByKey([1, 2], (item, index) => { if (index === 1) throw new Error('bad key'); return 'ok'; });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SnapshotAggregationError);
      expect(err.metadata.index).toBe(1);
    }
  });
});

describe('accumulate', () => {
  it('returns both the final state and full running history', () => {
    const { final, history } = accumulate([1, 2, 3], (state, item) => state + item, 0);
    expect(final).toBe(6);
    expect(history).toEqual([1, 3, 6]);
  });

  it('wraps a throwing accumulatorFn', () => {
    expect(() => accumulate([1], () => { throw new Error('bad'); }, 0)).toThrow(SnapshotAggregationError);
  });
});

describe('summarize', () => {
  it('runs every named summarizer against the full item list', () => {
    const items = [1, 2, 3, 4];
    const summary = summarize(items, {
      count: (all) => all.length,
      sum: (all) => all.reduce((a, b) => a + b, 0),
    });
    expect(summary).toEqual({ count: 4, sum: 10 });
  });

  it('rejects a non-object summarizers argument', () => {
    expect(() => summarize([1], null)).toThrow(SnapshotAggregationError);
  });

  it('wraps a throwing summarizer, naming the offending summarizer', () => {
    try {
      summarize([1], { bad: () => { throw new Error('nope'); } });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SnapshotAggregationError);
      expect(err.metadata.summarizer).toBe('bad');
    }
  });

  it('is deterministic — identical items and summarizers produce identical output', () => {
    const items = [1, 2, 3];
    const summarizers = { count: (all) => all.length };
    expect(summarize(items, summarizers)).toEqual(summarize(items, summarizers));
  });
});
