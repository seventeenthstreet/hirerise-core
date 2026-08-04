'use strict';

/**
 * @file core/src/modules/snapshot-intelligence/computation/results/snapshot.computation.results.js
 *
 * KR-02C — Snapshot Computation Engine
 *
 * Immutable computation result objects, per KR-02C's "Computation
 * Result" deliverable: SnapshotComputationResult,
 * SnapshotComputationSummary, SnapshotComputationStatistics,
 * SnapshotComputationDiagnostics.
 *
 * Follows the certified domain layer's plain-object / factory-function
 * / deep-freeze convention. These are generic result containers — no
 * business scoring, no interpretation of *what* a rule computed, only
 * *how* the computation ran and *what* it produced structurally. A
 * later work package (business scoring, CHI, etc.) is expected to place
 * its domain-specific values inside `SnapshotComputationResult.value`
 * (an opaque payload from this framework's point of view) rather than
 * this module growing business-specific fields.
 */

const { deepFreeze } = require('../../domain/value-objects/snapshot.valueObjects');
const { SnapshotComputationValidationError } = require('../errors/snapshot.computation.errors');

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function assert(condition, message, field) {
  if (!condition) {
    throw new SnapshotComputationValidationError(message, { field });
  }
}

/**
 * @typedef {Object} SnapshotComputationDiagnostics
 * @property {Array<Object>} ruleErrors - one entry per rule that threw
 * during evaluation ({ ruleId, message, code })
 * @property {Array<string>} notes - free-form, non-authoritative
 * diagnostic notes a pipeline stage may append (e.g. "rule X skipped:
 * unsupported input")
 * @property {number} rulesConsidered
 * @property {number} rulesExecuted
 * @property {number} rulesFailed
 */

/**
 * @param {Object} [input]
 * @returns {SnapshotComputationDiagnostics}
 */
function createSnapshotComputationDiagnostics({
  ruleErrors = [], notes = [], rulesConsidered = 0, rulesExecuted = 0, rulesFailed = 0,
} = {}) {
  assert(Array.isArray(ruleErrors), 'SnapshotComputationDiagnostics.ruleErrors must be an array', 'ruleErrors');
  assert(Array.isArray(notes), 'SnapshotComputationDiagnostics.notes must be an array', 'notes');
  assert(Number.isInteger(rulesConsidered) && rulesConsidered >= 0, 'SnapshotComputationDiagnostics.rulesConsidered must be a non-negative integer', 'rulesConsidered');
  assert(Number.isInteger(rulesExecuted) && rulesExecuted >= 0, 'SnapshotComputationDiagnostics.rulesExecuted must be a non-negative integer', 'rulesExecuted');
  assert(Number.isInteger(rulesFailed) && rulesFailed >= 0, 'SnapshotComputationDiagnostics.rulesFailed must be a non-negative integer', 'rulesFailed');

  return deepFreeze({
    ruleErrors: ruleErrors.map((e) => ({ ...e })),
    notes: [...notes],
    rulesConsidered,
    rulesExecuted,
    rulesFailed,
  });
}

/**
 * @typedef {Object} SnapshotComputationStatistics
 * @property {number} inputCount - number of snapshots the computation consumed
 * @property {Object} counts - generic named counters (e.g. groups produced,
 * items aggregated) — the aggregation framework populates this, assigns
 * no business meaning to any key
 * @property {Object} durations - generic named stage timings, in the
 * caller's own units (this framework never reads a clock; if a caller
 * wants durations, it supplies them as pre-computed numbers)
 */

/**
 * @param {Object} [input]
 * @returns {SnapshotComputationStatistics}
 */
function createSnapshotComputationStatistics({
  inputCount = 0, counts = {}, durations = {},
} = {}) {
  assert(Number.isInteger(inputCount) && inputCount >= 0, 'SnapshotComputationStatistics.inputCount must be a non-negative integer', 'inputCount');
  assert(isPlainObject(counts), 'SnapshotComputationStatistics.counts must be an object', 'counts');
  assert(isPlainObject(durations), 'SnapshotComputationStatistics.durations must be an object', 'durations');

  return deepFreeze({
    inputCount,
    counts: { ...counts },
    durations: { ...durations },
  });
}

/**
 * @typedef {Object} SnapshotComputationSummary
 * @property {string} scope - the evaluation scope the computation ran under
 * @property {string} status - "COMPLETED" | "COMPLETED_WITH_ERRORS" | "FAILED"
 * @property {number} ruleCount - total rules considered
 * @property {Object} groups - generic grouping result, produced by the
 * aggregation framework's groupByKey primitive (keyed by whatever key
 * function the caller/rule supplied — this framework assigns no
 * business meaning to any group key)
 */

const SnapshotComputationStatus = Object.freeze({
  COMPLETED: 'COMPLETED',
  COMPLETED_WITH_ERRORS: 'COMPLETED_WITH_ERRORS',
  FAILED: 'FAILED',
});

/**
 * @param {Object} [input]
 * @returns {SnapshotComputationSummary}
 */
function createSnapshotComputationSummary({
  scope, status, ruleCount = 0, groups = {},
} = {}) {
  assert(typeof scope === 'string' && scope.length > 0, 'SnapshotComputationSummary.scope must be a non-empty string', 'scope');
  assert(
    Object.values(SnapshotComputationStatus).includes(status),
    `SnapshotComputationSummary.status must be one of ${Object.values(SnapshotComputationStatus).join(', ')}`,
    'status',
  );
  assert(Number.isInteger(ruleCount) && ruleCount >= 0, 'SnapshotComputationSummary.ruleCount must be a non-negative integer', 'ruleCount');
  assert(isPlainObject(groups), 'SnapshotComputationSummary.groups must be an object', 'groups');

  return deepFreeze({
    scope,
    status,
    ruleCount,
    groups: { ...groups },
  });
}

/**
 * @typedef {Object} SnapshotComputationResult - the canonical, immutable
 * output of SnapshotComputationEngine#compute.
 * @property {*} value - the opaque aggregated computation value (shape
 * defined entirely by whichever rules/aggregation a caller configured;
 * this framework never inspects it)
 * @property {SnapshotComputationSummary} summary
 * @property {SnapshotComputationStatistics} statistics
 * @property {SnapshotComputationDiagnostics} diagnostics
 * @property {Object} context - the SnapshotComputationContext the
 * computation ran under (echoed back for traceability; already frozen
 * by its own factory)
 */

/**
 * @param {Object} input
 * @returns {SnapshotComputationResult}
 */
function createSnapshotComputationResult({
  value, summary, statistics, diagnostics, context,
} = {}) {
  assert(isPlainObject(summary), 'SnapshotComputationResult.summary must be a SnapshotComputationSummary', 'summary');
  assert(isPlainObject(statistics), 'SnapshotComputationResult.statistics must be a SnapshotComputationStatistics', 'statistics');
  assert(isPlainObject(diagnostics), 'SnapshotComputationResult.diagnostics must be a SnapshotComputationDiagnostics', 'diagnostics');
  assert(isPlainObject(context), 'SnapshotComputationResult.context must be a SnapshotComputationContext', 'context');

  const result = {
    value,
    summary,
    statistics,
    diagnostics,
    context,
  };
  // `value` may legitimately be a primitive, array, or already-frozen
  // object; deepFreeze only needs to reach the fields this factory owns
  // directly, since summary/statistics/diagnostics/context are already
  // frozen by their own factories before arriving here.
  return deepFreeze(result);
}

module.exports = {
  SnapshotComputationStatus,
  createSnapshotComputationResult,
  createSnapshotComputationSummary,
  createSnapshotComputationStatistics,
  createSnapshotComputationDiagnostics,
};
