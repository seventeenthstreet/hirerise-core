'use strict';

/**
 * @file core/src/modules/snapshot-intelligence/computation/__tests__/computation.determinism.test.js
 * KR-02C — Snapshot Computation Engine — determinism & immutability
 * exit-criterion tests (KR-02C Deliverable #10: "deterministic
 * execution", "identical input → identical output", "immutable
 * results").
 */

const { SnapshotComputationEngine } = require('../engine/SnapshotComputationEngine');
const { SnapshotComputationRule } = require('../rules/snapshot.computation.ruleContract');
const { groupByKey, summarize } = require('../aggregation/snapshot.computation.aggregation');
const { buildComputationSnapshots, buildComputationContext } = require('../testHelpers/computation.fixtures');

class EchoCountRule extends SnapshotComputationRule {
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  supports(input, context) {
    return true;
  }

  // eslint-disable-next-line class-methods-use-this
  evaluate(input) {
    return input.snapshots.length;
  }
}

describe('determinism — identical input produces identical output', () => {
  it('SnapshotComputationEngine#compute is deterministic across repeated runs', () => {
    const engine = new SnapshotComputationEngine({ rules: [new EchoCountRule('count')] });
    const snapshots = buildComputationSnapshots(5);
    const context = buildComputationContext();

    const results = Array.from({ length: 5 }, () => engine.compute(snapshots, context));
    results.forEach((result) => expect(result).toEqual(results[0]));
  });

  it('is order-insensitive on the input array (normalization stage sorts deterministically)', () => {
    const engine = new SnapshotComputationEngine({ rules: [new EchoCountRule('count')] });
    const snapshots = buildComputationSnapshots(4);
    const context = buildComputationContext();
    const reversed = [...snapshots].reverse();

    const resultInOrder = engine.compute(snapshots, context);
    const resultReversed = engine.compute(reversed, context);

    expect(resultInOrder).toEqual(resultReversed);
  });

  it('aggregation primitives are deterministic given deterministic caller functions', () => {
    const items = [{ k: 'a' }, { k: 'b' }, { k: 'a' }];
    const first = groupByKey(items, (i) => i.k);
    const second = groupByKey(items, (i) => i.k);
    expect(first).toEqual(second);

    const summaryA = summarize(items, { count: (all) => all.length });
    const summaryB = summarize(items, { count: (all) => all.length });
    expect(summaryA).toEqual(summaryB);
  });
});

describe('immutability — every computation result is deeply frozen', () => {
  it('freezes the result, and its summary/statistics/diagnostics members', () => {
    const engine = new SnapshotComputationEngine({ rules: [new EchoCountRule('count')] });
    const result = engine.compute(buildComputationSnapshots(2), buildComputationContext());

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.summary)).toBe(true);
    expect(Object.isFrozen(result.statistics)).toBe(true);
    expect(Object.isFrozen(result.diagnostics)).toBe(true);
    expect(Object.isFrozen(result.context)).toBe(true);
    expect(Object.isFrozen(result.value)).toBe(true);
  });

  it('throws when attempting to mutate any frozen result member', () => {
    const engine = new SnapshotComputationEngine({ rules: [new EchoCountRule('count')] });
    const result = engine.compute(buildComputationSnapshots(1), buildComputationContext());

    expect(() => { result.summary.status = 'FAILED'; }).toThrow(TypeError);
    expect(() => { result.statistics.inputCount = 999; }).toThrow(TypeError);
    expect(() => { result.diagnostics.rulesFailed = 999; }).toThrow(TypeError);
  });
});
