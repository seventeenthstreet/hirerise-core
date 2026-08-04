'use strict';

/**
 * @file core/src/modules/snapshot-intelligence/computation/pipeline/snapshot.computation.pipeline.js
 *
 * KR-02C — Snapshot Computation Engine
 *
 * The deterministic execution pipeline, per KR-02C's "Computation
 * Pipeline" deliverable. Five composable stages, run in order:
 *
 *   validation → normalization → evaluation → aggregation → result construction
 *
 * Each stage is a pure function `(state) -> state`, where `state` is a
 * plain, mutable-by-convention-only-within-a-single-stage working
 * object (never the frozen SnapshotComputationContext or the frozen
 * Snapshot entities themselves — those are only ever read). Stages are
 * composed left-to-right by `composePipeline`, which threads `state`
 * through each stage and stops at the first stage that throws.
 *
 * Composability (KR-02C: "Pipeline stages shall be composable"): every
 * stage below has the exact same `(state) -> state` shape, so a caller
 * may reorder, omit, replace, or add stages by building a different
 * array and passing it to `composePipeline` — the default pipeline
 * (`createDefaultComputationPipeline`) is just one particular
 * composition, not a privileged one.
 */

const { SnapshotPipelineCompositionError } = require('../errors/snapshot.computation.errors');
const {
  validateComputationInput,
} = require('../validation/snapshot.computation.validation');
const { executeRules } = require('../rules/snapshot.computation.ruleEngine');
const { groupByKey, summarize } = require('../aggregation/snapshot.computation.aggregation');
const {
  createSnapshotComputationResult,
  createSnapshotComputationSummary,
  createSnapshotComputationStatistics,
  createSnapshotComputationDiagnostics,
  SnapshotComputationStatus,
} = require('../results/snapshot.computation.results');

/**
 * @typedef {Object} ComputationPipelineState
 * @property {Array} snapshots - raw input, as supplied to the engine
 * @property {Object} context - the SnapshotComputationContext
 * @property {ReadonlyArray<Object>} ruleSet - validated rule set to execute
 * @property {Array} [normalizedSnapshots] - set by the normalization stage
 * @property {Array} [ruleOutcomes] - set by the evaluation stage
 * @property {Object} [aggregation] - set by the aggregation stage
 * @property {Object} [result] - set by the result-construction stage
 */

/**
 * Stage 1 — validation. Delegates entirely to
 * ../validation/snapshot.computation.validation.js's `validateComputationInput`
 * (input consistency, snapshot integrity, execution context) per
 * KR-02C's "Reuse existing domain validation where appropriate" —
 * nothing here re-implements a check that module already performs.
 *
 * @param {ComputationPipelineState} state
 * @returns {ComputationPipelineState}
 */
function validationStage(state) {
  validateComputationInput(state.snapshots, state.context);
  return state;
}

/**
 * Stage 2 — normalization. Produces a deterministic working order for
 * the snapshot batch (stable sort by SnapshotIdentifier — the only
 * field guaranteed present, unique, and comparable on every certified
 * Snapshot entity) so that rule/aggregation output ordering never
 * depends on the caller's original array order, per KR-02C's
 * determinism exit criterion. Does not mutate or clone the snapshots
 * themselves — they are certified, already-frozen domain entities;
 * normalization only decides the array order the rest of the pipeline
 * observes.
 *
 * @param {ComputationPipelineState} state
 * @returns {ComputationPipelineState}
 */
function normalizationStage(state) {
  const normalizedSnapshots = [...state.snapshots].sort((a, b) => {
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
  return { ...state, normalizedSnapshots };
}

/**
 * Stage 3 — evaluation. Runs the rule execution framework
 * (../rules/snapshot.computation.ruleEngine.js) against the normalized
 * snapshot batch. The "input" passed to each rule is the normalized
 * batch plus the context — a rule decides for itself (via `supports`)
 * whether and how it wants to look at that batch (per-snapshot,
 * whole-batch, etc.); the pipeline does not iterate snapshots on a
 * rule's behalf, since KR-02C's rule framework is deliberately
 * batch-agnostic (only future business rules decide their own
 * cardinality).
 *
 * @param {ComputationPipelineState} state
 * @returns {ComputationPipelineState}
 */
function evaluationStage(state) {
  const ruleInput = { snapshots: state.normalizedSnapshots };
  const ruleOutcomes = executeRules(state.ruleSet, ruleInput, state.context);
  return { ...state, ruleOutcomes };
}

/**
 * Stage 4 — aggregation. Uses the generic aggregation framework
 * (../aggregation/snapshot.computation.aggregation.js) to reduce the
 * rule execution outcomes into a structural (not business) summary:
 * outcomes grouped by status, and named counts. No business scoring —
 * "remain generic" (KR-02C Mission).
 *
 * @param {ComputationPipelineState} state
 * @returns {ComputationPipelineState}
 */
function aggregationStage(state) {
  const outcomes = state.ruleOutcomes ?? [];
  const groupedByStatus = groupByKey(outcomes, (outcome) => outcome.status);
  const counts = summarize(outcomes, {
    considered: (items) => items.length,
    evaluated: (items) => items.filter((o) => o.status === 'EVALUATED').length,
    skipped: (items) => items.filter((o) => o.status === 'SKIPPED').length,
    failed: (items) => items.filter((o) => o.status === 'FAILED').length,
  });
  return { ...state, aggregation: { groupedByStatus, counts } };
}

/**
 * Stage 5 — result construction. Assembles the immutable
 * SnapshotComputationResult (and its Summary / Statistics / Diagnostics
 * members) per ../results/snapshot.computation.results.js. This is the
 * only stage permitted to construct those result objects — earlier
 * stages only build the plain working `state`.
 *
 * `value` on the returned result is the ordered list of every rule's
 * EVALUATED outcome (`{ ruleId, value }`), since this generic framework
 * has no business meaning to reduce those further into — a caller that
 * wants a single scalar/aggregate business value supplies a rule (or a
 * post-processing step of its own) that produces exactly one EVALUATED
 * outcome, or reduces `diagnostics`/`statistics` itself.
 *
 * @param {ComputationPipelineState} state
 * @returns {ComputationPipelineState}
 */
function resultConstructionStage(state) {
  const outcomes = state.ruleOutcomes ?? [];
  const { counts, groupedByStatus } = state.aggregation ?? { counts: {}, groupedByStatus: {} };

  const ruleErrors = outcomes
    .filter((o) => o.status === 'FAILED')
    .map((o) => ({ ruleId: o.ruleId, message: o.error?.message, code: o.error?.code }));

  const status = ruleErrors.length === 0
    ? SnapshotComputationStatus.COMPLETED
    : (counts.evaluated > 0
      ? SnapshotComputationStatus.COMPLETED_WITH_ERRORS
      : SnapshotComputationStatus.FAILED);

  const summary = createSnapshotComputationSummary({
    scope: state.context.scope,
    status,
    ruleCount: state.ruleSet.length,
    groups: Object.fromEntries(
      Object.entries(groupedByStatus).map(([key, items]) => [key, items.length]),
    ),
  });

  const statistics = createSnapshotComputationStatistics({
    inputCount: state.normalizedSnapshots.length,
    counts,
    durations: {},
  });

  const diagnostics = createSnapshotComputationDiagnostics({
    ruleErrors,
    notes: [],
    rulesConsidered: counts.considered ?? 0,
    rulesExecuted: counts.evaluated ?? 0,
    rulesFailed: counts.failed ?? 0,
  });

  const result = createSnapshotComputationResult({
    value: outcomes.filter((o) => o.status === 'EVALUATED').map((o) => ({ ruleId: o.ruleId, value: o.value })),
    summary,
    statistics,
    diagnostics,
    context: state.context,
  });

  return { ...state, result };
}

/**
 * The canonical stage order (KR-02C Mission: "Stages: validation,
 * normalization, evaluation, aggregation, result construction").
 */
const DEFAULT_PIPELINE_STAGES = Object.freeze([
  validationStage,
  normalizationStage,
  evaluationStage,
  aggregationStage,
  resultConstructionStage,
]);

/**
 * Composes an array of stage functions into a single function that
 * threads `state` through each in order. Each stage must be a function
 * of one argument and must return an object (the next state) — a
 * mis-composed stage (wrong arity, non-function, non-object return) is
 * reported as SnapshotPipelineCompositionError rather than allowed to
 * fail confusingly mid-run.
 *
 * @param {Array<(state: ComputationPipelineState) => ComputationPipelineState>} stages
 * @returns {(initialState: ComputationPipelineState) => ComputationPipelineState}
 */
function composePipeline(stages) {
  if (!Array.isArray(stages) || stages.length === 0) {
    throw new SnapshotPipelineCompositionError('composePipeline requires a non-empty array of stage functions');
  }
  stages.forEach((stage, index) => {
    if (typeof stage !== 'function') {
      throw new SnapshotPipelineCompositionError(`Pipeline stage at index ${index} is not a function`, { index });
    }
  });

  return function runPipeline(initialState) {
    return stages.reduce((state, stage, index) => {
      const next = stage(state);
      if (next === null || typeof next !== 'object') {
        throw new SnapshotPipelineCompositionError(
          `Pipeline stage at index ${index} (${stage.name || 'anonymous'}) did not return a state object`,
          { index, stageName: stage.name },
        );
      }
      return next;
    }, initialState);
  };
}

/**
 * Builds the default, canonical five-stage computation pipeline.
 *
 * @returns {(initialState: ComputationPipelineState) => ComputationPipelineState}
 */
function createDefaultComputationPipeline() {
  return composePipeline(DEFAULT_PIPELINE_STAGES);
}

module.exports = {
  validationStage,
  normalizationStage,
  evaluationStage,
  aggregationStage,
  resultConstructionStage,
  DEFAULT_PIPELINE_STAGES,
  composePipeline,
  createDefaultComputationPipeline,
};
