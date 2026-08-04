'use strict';

/**
 * @file core/src/modules/snapshot-intelligence/computation/engine/SnapshotComputationEngine.js
 *
 * KR-02C — Snapshot Computation Engine
 *
 * The canonical computation engine, per KR-02C's "SnapshotComputationEngine"
 * deliverable and the work package's overall Mission: a pure domain
 * service that consumes certified Snapshot domain objects, performs
 * deterministic computation, and produces immutable computation
 * results. No persistence, no databases, no APIs, no orchestration, no
 * AI models, no narrative generation, no LLMs, no scheduling, no
 * asynchronous processing — every method on this class is synchronous.
 *
 * The engine "shall not know where snapshots came from" (KR-02C
 * Deliverable #1): it receives an array of already-constructed,
 * certified Snapshot entities as a plain argument; it never imports a
 * repository, never calls out to any I/O boundary, and holds no
 * reference to one.
 *
 * The engine instance itself is configuration, not runtime state
 * (KR-02C: "stateless"): its constructor accepts an immutable rule set
 * and an immutable pipeline function, and every `compute` call is a
 * pure function of (snapshots, context) plus that fixed configuration —
 * calling `compute` never mutates the engine, and two calls with
 * identical arguments against the same engine instance always produce
 * deep-equal (though not reference-equal, since each result is a fresh
 * frozen object) results.
 */

const { createRuleSet } = require('../rules/snapshot.computation.ruleEngine');
const { createDefaultComputationPipeline } = require('../pipeline/snapshot.computation.pipeline');
const {
  validateComputationInput,
} = require('../validation/snapshot.computation.validation');

class SnapshotComputationEngine {
  /**
   * @param {Object} [options]
   * @param {Array<Object>} [options.rules] - computation rules this
   * engine instance will run on every `compute` call, in the given
   * order (KR-02C Deliverable #5: "ordered execution"). Defaults to an
   * empty rule set — an engine with no rules configured still computes
   * a valid (empty) result, per KR-02C's explicit constraint that this
   * work package implements only the framework, not any
   * business-specific rule.
   * @param {(state: Object) => Object} [options.pipeline] - a composed
   * pipeline function, as returned by
   * ../pipeline/snapshot.computation.pipeline.js's `composePipeline`.
   * Defaults to the canonical five-stage pipeline
   * (`createDefaultComputationPipeline`). Supplying a custom pipeline is
   * how a caller extends or reorders stages without subclassing the
   * engine (KR-02C: "dependency-invertible").
   */
  constructor({ rules = [], pipeline = createDefaultComputationPipeline() } = {}) {
    this.ruleSet = createRuleSet(rules);
    this.pipeline = pipeline;
    Object.freeze(this);
  }

  /**
   * Validates a candidate (snapshots, context) pair without executing
   * any rule or aggregation logic — a convenience wrapper around
   * ../validation/snapshot.computation.validation.js's
   * `validateComputationInput`, exposed on the engine so a caller can
   * pre-flight input before committing to a full `compute` call.
   * Throws SnapshotComputationValidationError on invalid input;
   * returns nothing on success.
   *
   * @param {Array<Object>} snapshots
   * @param {import('../context/snapshot.computation.context').SnapshotComputationContext} context
   */
  validate(snapshots, context) {
    validateComputationInput(snapshots, context);
  }

  /**
   * Runs the full computation pipeline (validation → normalization →
   * evaluation → aggregation → result construction) against `snapshots`
   * under `context`, using this engine's configured rule set, and
   * returns an immutable SnapshotComputationResult.
   *
   * Deterministic: identical `snapshots`, `context`, and this engine's
   * fixed rule set/pipeline always produce a deep-equal result (KR-02C
   * exit criterion "identical input → identical output"). Synchronous:
   * no Promise is returned, no microtask is scheduled, per the Mission's
   * explicit "SHALL NOT ... perform asynchronous processing".
   *
   * @param {Array<Object>} snapshots - certified Snapshot entities
   * @param {import('../context/snapshot.computation.context').SnapshotComputationContext} context
   * @returns {import('../results/snapshot.computation.results').SnapshotComputationResult}
   */
  compute(snapshots, context) {
    const initialState = {
      snapshots,
      context,
      ruleSet: this.ruleSet,
    };
    const finalState = this.pipeline(initialState);
    return finalState.result;
  }
}

module.exports = {
  SnapshotComputationEngine,
};
