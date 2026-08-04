'use strict';

/**
 * @file core/src/modules/snapshot-intelligence/computation/errors/snapshot.computation.errors.js
 *
 * KR-02C — Snapshot Computation Engine
 *
 * Named error classes for the Snapshot Computation boundary, following
 * the same standalone-hierarchy convention already established by the
 * certified domain layer (domain/errors/snapshot.errors.js) and the
 * certified repository layer (repository/errors/snapshot.repository.errors.js):
 * a base class carrying a machine-readable `code` and free-form
 * `metadata`, with named subclasses for every distinct failure mode a
 * caller needs to branch on.
 *
 * These errors are deliberately infrastructure-neutral (KR-02C Mission:
 * "Errors remain infrastructure-neutral"). Nothing in this hierarchy
 * carries an HTTP status, a database error code, or any other
 * transport/persistence concern — a later boundary (KR-02D/E/G) is
 * expected to translate these into its own error shape, exactly as the
 * domain and repository layers already document for their own error
 * hierarchies.
 *
 * SnapshotComputationError is never thrown directly — always one of the
 * named subclasses below.
 */

class SnapshotComputationError extends Error {
  /**
   * @param {string} message
   * @param {string} code - machine-readable error code
   * @param {object} [metadata]
   */
  constructor(message, code, metadata = {}) {
    super(message);
    this.name = 'SnapshotComputationError';
    this.code = code;
    this.metadata = metadata;
    Error.captureStackTrace?.(this, SnapshotComputationError);
  }
}

/**
 * Thrown when the computation engine's inputs — snapshots, computation
 * context, or computation parameters — fail structural or consistency
 * validation before any rule or aggregation logic runs. This is the
 * engine's own boundary-validation error; it is distinct from the
 * certified domain layer's SnapshotValidationError, which guards entity
 * construction and is reused (not duplicated) by
 * ../validation/snapshot.computation.validation.js where a computation
 * input is itself expected to be a certified Snapshot entity.
 */
class SnapshotComputationValidationError extends SnapshotComputationError {
  constructor(message, metadata = {}) {
    super(message, 'SNAPSHOT_COMPUTATION_VALIDATION_ERROR', metadata);
    this.name = 'SnapshotComputationValidationError';
  }
}

/**
 * Thrown when a single computation rule (../rules) fails during
 * evaluation. Carries the offending rule's identifier in metadata so a
 * caller — or the rule execution framework's own isolation logic — can
 * attribute the failure to exactly one rule without that rule's failure
 * being confused with a pipeline-level or aggregation-level failure.
 */
class SnapshotRuleExecutionError extends SnapshotComputationError {
  constructor(message, metadata = {}) {
    super(message, 'SNAPSHOT_RULE_EXECUTION_ERROR', metadata);
    this.name = 'SnapshotRuleExecutionError';
  }
}

/**
 * Thrown when the aggregation framework (../aggregation) is asked to
 * reduce, group, accumulate, or summarize a malformed or inconsistent
 * set of rule outputs — for example, a non-iterable input, or a
 * reducer/grouping function that itself throws.
 */
class SnapshotAggregationError extends SnapshotComputationError {
  constructor(message, metadata = {}) {
    super(message, 'SNAPSHOT_AGGREGATION_ERROR', metadata);
    this.name = 'SnapshotAggregationError';
  }
}

/**
 * Thrown when a pipeline stage (../pipeline) receives a malformed
 * execution state — i.e. a wiring/composition error between stages,
 * rather than a problem with the original snapshots/context/rules
 * themselves. Kept distinct from SnapshotComputationValidationError
 * (which guards the engine's *public* input) so a caller can tell "you
 * gave the engine bad input" apart from "the pipeline itself is
 * mis-composed" — the latter should never happen with the engine's own
 * default pipeline and indicates a programming error in a custom one.
 */
class SnapshotPipelineCompositionError extends SnapshotComputationError {
  constructor(message, metadata = {}) {
    super(message, 'SNAPSHOT_PIPELINE_COMPOSITION_ERROR', metadata);
    this.name = 'SnapshotPipelineCompositionError';
  }
}

module.exports = {
  SnapshotComputationError,
  SnapshotComputationValidationError,
  SnapshotRuleExecutionError,
  SnapshotAggregationError,
  SnapshotPipelineCompositionError,
};
