'use strict';

/**
 * @file core/src/modules/snapshot-intelligence/computation/__tests__/computation.engine.test.js
 * KR-02C — Snapshot Computation Engine — SnapshotComputationEngine tests.
 */

const { SnapshotComputationEngine } = require('../engine/SnapshotComputationEngine');
const { SnapshotComputationRule } = require('../rules/snapshot.computation.ruleContract');
const { SnapshotComputationValidationError } = require('../errors/snapshot.computation.errors');
const { buildComputationSnapshots, buildComputationContext } = require('../testHelpers/computation.fixtures');

class ConstantRule extends SnapshotComputationRule {
  constructor(id, value) {
    super({ id });
    this.value = value;
  }

  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  supports(input, context) {
    return true;
  }

  evaluate() {
    return this.value;
  }
}

class FailingRule extends SnapshotComputationRule {
  constructor(id) {
    super({ id });
  }

  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  supports(input, context) {
    return true;
  }

  // eslint-disable-next-line class-methods-use-this
  evaluate() {
    throw new Error('rule failure');
  }
}

describe('SnapshotComputationEngine construction', () => {
  it('defaults to an empty rule set and the default pipeline', () => {
    const engine = new SnapshotComputationEngine();
    expect(engine.ruleSet).toEqual([]);
    expect(typeof engine.pipeline).toBe('function');
  });

  it('is frozen — an engine instance cannot be mutated after construction', () => {
    const engine = new SnapshotComputationEngine();
    expect(() => {
      engine.ruleSet = [];
    }).toThrow(TypeError);
  });

  it('rejects a malformed rule at construction time', () => {
    expect(() => new SnapshotComputationEngine({ rules: [{ id: 'bad' }] })).toThrow();
  });
});

describe('SnapshotComputationEngine#validate', () => {
  it('does not throw for valid input', () => {
    const engine = new SnapshotComputationEngine();
    expect(() => engine.validate(buildComputationSnapshots(1), buildComputationContext())).not.toThrow();
  });

  it('throws SnapshotComputationValidationError for invalid input without running compute', () => {
    const engine = new SnapshotComputationEngine();
    expect(() => engine.validate([], buildComputationContext())).toThrow(SnapshotComputationValidationError);
  });
});

describe('SnapshotComputationEngine#compute', () => {
  it('computes an empty result when no rules are configured', () => {
    const engine = new SnapshotComputationEngine();
    const result = engine.compute(buildComputationSnapshots(1), buildComputationContext());
    expect(result.value).toEqual([]);
    expect(result.summary.status).toBe('COMPLETED');
    expect(result.summary.ruleCount).toBe(0);
  });

  it('computes COMPLETED with every configured rule\'s value', () => {
    const engine = new SnapshotComputationEngine({
      rules: [new ConstantRule('r1', 1), new ConstantRule('r2', 2)],
    });
    const result = engine.compute(buildComputationSnapshots(2), buildComputationContext());
    expect(result.summary.status).toBe('COMPLETED');
    expect(result.value).toEqual([
      { ruleId: 'r1', value: 1 },
      { ruleId: 'r2', value: 2 },
    ]);
  });

  it('computes COMPLETED_WITH_ERRORS when some rules fail and others succeed', () => {
    const engine = new SnapshotComputationEngine({
      rules: [new FailingRule('bad'), new ConstantRule('good', 'ok')],
    });
    const result = engine.compute(buildComputationSnapshots(1), buildComputationContext());
    expect(result.summary.status).toBe('COMPLETED_WITH_ERRORS');
    expect(result.diagnostics.rulesFailed).toBe(1);
    expect(result.diagnostics.ruleErrors[0].ruleId).toBe('bad');
    expect(result.value).toEqual([{ ruleId: 'good', value: 'ok' }]);
  });

  it('computes FAILED when every rule fails', () => {
    const engine = new SnapshotComputationEngine({ rules: [new FailingRule('bad')] });
    const result = engine.compute(buildComputationSnapshots(1), buildComputationContext());
    expect(result.summary.status).toBe('FAILED');
    expect(result.value).toEqual([]);
  });

  it('throws SnapshotComputationValidationError for invalid input rather than producing a result', () => {
    const engine = new SnapshotComputationEngine();
    expect(() => engine.compute([], buildComputationContext())).toThrow(SnapshotComputationValidationError);
  });

  it('is synchronous — compute never returns a Promise', () => {
    const engine = new SnapshotComputationEngine({ rules: [new ConstantRule('r1', 1)] });
    const result = engine.compute(buildComputationSnapshots(1), buildComputationContext());
    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof result.then).toBe('undefined');
  });

  it('is deterministic — identical input produces a deep-equal, non-reference-equal result', () => {
    const engine = new SnapshotComputationEngine({ rules: [new ConstantRule('r1', 1)] });
    const snapshots = buildComputationSnapshots(2);
    const context = buildComputationContext();

    const first = engine.compute(snapshots, context);
    const second = engine.compute(snapshots, context);

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it('does not mutate its input snapshots or context', () => {
    const engine = new SnapshotComputationEngine({ rules: [new ConstantRule('r1', 1)] });
    const snapshots = buildComputationSnapshots(1);
    const context = buildComputationContext();
    const snapshotsCopy = JSON.parse(JSON.stringify(snapshots));
    const contextCopy = JSON.parse(JSON.stringify(context));

    engine.compute(snapshots, context);

    expect(JSON.parse(JSON.stringify(snapshots))).toEqual(snapshotsCopy);
    expect(JSON.parse(JSON.stringify(context))).toEqual(contextCopy);
  });

  it('never performs asynchronous work, persistence, or infrastructure calls', () => {
    const engineSource = require('fs').readFileSync(
      require.resolve('../engine/SnapshotComputationEngine'),
      'utf8',
    );
    expect(engineSource).not.toMatch(/\basync\b/);
    expect(engineSource).not.toMatch(/\bfetch\(/);
    expect(engineSource).not.toMatch(/require\(['"](?:axios|supabase|pg|redis|ioredis)/);
  });
});
