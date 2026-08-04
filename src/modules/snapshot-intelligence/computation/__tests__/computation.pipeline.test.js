'use strict';

/**
 * @file core/src/modules/snapshot-intelligence/computation/__tests__/computation.pipeline.test.js
 * KR-02C — Snapshot Computation Engine — Computation Pipeline tests.
 */

const {
  validationStage,
  normalizationStage,
  evaluationStage,
  aggregationStage,
  resultConstructionStage,
  DEFAULT_PIPELINE_STAGES,
  composePipeline,
  createDefaultComputationPipeline,
} = require('../pipeline/snapshot.computation.pipeline');
const { createRuleSet } = require('../rules/snapshot.computation.ruleEngine');
const { SnapshotComputationRule } = require('../rules/snapshot.computation.ruleContract');
const { SnapshotComputationValidationError, SnapshotPipelineCompositionError } = require('../errors/snapshot.computation.errors');
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

describe('DEFAULT_PIPELINE_STAGES / stage order', () => {
  it('is exactly the five canonical stages, in order', () => {
    expect(DEFAULT_PIPELINE_STAGES).toEqual([
      validationStage,
      normalizationStage,
      evaluationStage,
      aggregationStage,
      resultConstructionStage,
    ]);
    expect(Object.isFrozen(DEFAULT_PIPELINE_STAGES)).toBe(true);
  });
});

describe('composePipeline', () => {
  it('threads state through stages in order', () => {
    const run = composePipeline([
      (state) => ({ ...state, a: 1 }),
      (state) => ({ ...state, b: state.a + 1 }),
    ]);
    expect(run({})).toEqual({ a: 1, b: 2 });
  });

  it('rejects an empty stage array', () => {
    expect(() => composePipeline([])).toThrow(SnapshotPipelineCompositionError);
  });

  it('rejects a non-function stage', () => {
    expect(() => composePipeline([1])).toThrow(SnapshotPipelineCompositionError);
  });

  it('rejects a stage that does not return a state object', () => {
    const run = composePipeline([() => null]);
    expect(() => run({})).toThrow(SnapshotPipelineCompositionError);
  });
});

describe('validationStage', () => {
  it('passes through valid state unchanged', () => {
    const snapshots = buildComputationSnapshots(1);
    const context = buildComputationContext();
    const state = { snapshots, context };
    expect(validationStage(state)).toBe(state);
  });

  it('throws SnapshotComputationValidationError for invalid input', () => {
    expect(() => validationStage({ snapshots: [], context: buildComputationContext() }))
      .toThrow(SnapshotComputationValidationError);
  });
});

describe('normalizationStage', () => {
  it('produces a deterministic order regardless of input order', () => {
    const snapshots = buildComputationSnapshots(3);
    const shuffled = [snapshots[2], snapshots[0], snapshots[1]];
    const context = buildComputationContext();

    const a = normalizationStage({ snapshots, context });
    const b = normalizationStage({ snapshots: shuffled, context });

    expect(a.normalizedSnapshots.map((s) => s.id)).toEqual(b.normalizedSnapshots.map((s) => s.id));
    expect(a.normalizedSnapshots.map((s) => s.id)).toEqual(['snapshot-1', 'snapshot-2', 'snapshot-3']);
  });
});

describe('evaluationStage / aggregationStage / resultConstructionStage — full run', () => {
  it('produces a COMPLETED result when every rule evaluates cleanly', () => {
    const snapshots = buildComputationSnapshots(2);
    const context = buildComputationContext();
    const ruleSet = createRuleSet([new ConstantRule('r1', 10), new ConstantRule('r2', 20)]);

    let state = { snapshots, context, ruleSet };
    state = validationStage(state);
    state = normalizationStage(state);
    state = evaluationStage(state);
    state = aggregationStage(state);
    state = resultConstructionStage(state);

    expect(state.result.summary.status).toBe('COMPLETED');
    expect(state.result.summary.ruleCount).toBe(2);
    expect(state.result.value).toEqual([
      { ruleId: 'r1', value: 10 },
      { ruleId: 'r2', value: 20 },
    ]);
    expect(state.result.statistics.inputCount).toBe(2);
    expect(state.result.diagnostics.rulesFailed).toBe(0);
  });
});

describe('createDefaultComputationPipeline', () => {
  it('runs the canonical five stages end-to-end and is deterministic', () => {
    const pipeline = createDefaultComputationPipeline();
    const snapshots = buildComputationSnapshots(2);
    const context = buildComputationContext();
    const ruleSet = createRuleSet([new ConstantRule('r1', 'x')]);

    const first = pipeline({ snapshots, context, ruleSet });
    const second = pipeline({ snapshots, context, ruleSet });

    expect(first.result).toEqual(second.result);
    expect(first.result).not.toBe(second.result);
  });
});
