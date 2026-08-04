'use strict';

/**
 * @file core/src/modules/snapshot-intelligence/computation/context/snapshot.computation.context.js
 *
 * KR-02C — Snapshot Computation Engine
 *
 * SnapshotComputationContext, per KR-02C's "Computation Context"
 * deliverable. Follows the certified domain layer's plain-object /
 * factory-function convention (domain/entities/snapshot.entities.js,
 * domain/value-objects/snapshot.valueObjects.js): a context is a value,
 * not a behavior boundary, so it is a frozen plain object built by a
 * validating factory function rather than a class.
 *
 * A SnapshotComputationContext carries everything the computation
 * pipeline needs to run deterministically and nothing else:
 *
 *   - options        — computation options (which stages/rules to run,
 *                       feature toggles a caller controls)
 *   - scope           — the evaluation scope the computation is confined
 *                        to (mirrors the certified Snapshot entity's own
 *                        `scope` field, e.g. "resume")
 *   - parameters      — execution parameters (bounds, thresholds, or any
 *                        other caller-supplied input a rule or
 *                        aggregation step may read — the framework
 *                        itself assigns no meaning to any parameter name)
 *   - executedAt      — the deterministic execution timestamp. This
 *                        module never reads the wall clock itself (no
 *                        `Date.now()`/`new Date()` anywhere in this
 *                        file) — the caller supplies `executedAt`, so
 *                        that identical inputs (including this field)
 *                        always produce identical results, per KR-02C's
 *                        "identical input → identical output" exit
 *                        criterion.
 *
 * No infrastructure dependencies. No I/O. No side effects.
 */

const { deepFreeze } = require('../../domain/value-objects/snapshot.valueObjects');
const { SnapshotComputationValidationError } = require('../errors/snapshot.computation.errors');
const {
  validateSnapshotComputationContext,
} = require('../validation/snapshot.computation.validation');

/**
 * @typedef {Object} SnapshotComputationContext
 * @property {Object} options - computation options (frozen, may be empty)
 * @property {string} scope - the evaluation scope this computation is confined to
 * @property {Object} parameters - execution parameters (frozen, may be empty)
 * @property {string} executedAt - ISO-8601 timestamp supplied by the caller
 */

/**
 * Builds an immutable SnapshotComputationContext.
 *
 * @param {Object} [input]
 * @param {Object} [input.options]
 * @param {string} input.scope
 * @param {Object} [input.parameters]
 * @param {string} input.executedAt
 * @returns {SnapshotComputationContext}
 */
function createSnapshotComputationContext({
  options = {}, scope, parameters = {}, executedAt,
} = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new SnapshotComputationValidationError('SnapshotComputationContext.options must be an object', { field: 'options' });
  }
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw new SnapshotComputationValidationError('SnapshotComputationContext.parameters must be an object', { field: 'parameters' });
  }
  const context = {
    options: { ...options },
    scope,
    parameters: { ...parameters },
    executedAt,
  };
  validateSnapshotComputationContext(context);
  return deepFreeze(context);
}

module.exports = {
  createSnapshotComputationContext,
};
