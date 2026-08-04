'use strict';

/**
 * @file core/src/modules/snapshot-intelligence/computation/validation/snapshot.computation.validation.js
 *
 * KR-02C — Snapshot Computation Engine
 *
 * Deterministic, dependency-free validation functions for the
 * computation engine's own inputs, per KR-02C's "Validation" deliverable:
 *
 *   - input consistency        (validateComputationInput)
 *   - snapshot integrity        (validateComputationSnapshots — reuses,
 *                                 does not duplicate, the certified
 *                                 domain layer's own `validateSnapshot`)
 *   - execution context         (validateSnapshotComputationContext)
 *   - computation parameters    (validateComputationParameters)
 *
 * PURE FUNCTIONS ONLY — no I/O, no logging, no randomness, no ambient
 * state, mirroring the certified domain layer's own validation
 * convention (domain/schemas/snapshot.validation.js). Every validator
 * either returns void (valid) or throws
 * SnapshotComputationValidationError with a message naming the
 * offending field. None of these validators mutate their input.
 *
 * "Reuse existing domain validation where appropriate. Do not duplicate
 * domain validation." (KR-02C Mission, Deliverable #8): snapshot
 * integrity is validated by calling the certified domain layer's own
 * `validateSnapshot` (domain/schemas/snapshot.validation.js) rather than
 * re-checking Snapshot's field shape here.
 */

const { SnapshotComputationValidationError } = require('../errors/snapshot.computation.errors');
const { validateSnapshot } = require('../../domain/schemas/snapshot.validation');
const { SnapshotDomainError } = require('../../domain/errors/snapshot.errors');

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isIsoTimestamp(v) {
  if (!isNonEmptyString(v)) return false;
  const parsed = Date.parse(v);
  return Number.isFinite(parsed);
}

function assert(condition, message, field) {
  if (!condition) {
    throw new SnapshotComputationValidationError(message, { field });
  }
}

/**
 * Validates a single Snapshot passed to the computation engine by
 * reusing the certified domain layer's own `validateSnapshot`. Any
 * SnapshotDomainError it throws is re-wrapped as a
 * SnapshotComputationValidationError so that every error this module
 * (and everything downstream of it — the pipeline, the engine) throws
 * belongs to a single, computation-scoped hierarchy, per KR-02C's
 * "Errors remain infrastructure-neutral" / own error hierarchy
 * requirement — the domain layer's error identity is preserved as the
 * `cause`, not discarded.
 *
 * @param {*} snapshot
 * @param {number} [index] - position within the input batch, for error metadata
 */
function validateComputationSnapshot(snapshot, index) {
  try {
    validateSnapshot(snapshot);
  } catch (err) {
    if (err instanceof SnapshotDomainError) {
      throw new SnapshotComputationValidationError(
        `Snapshot at index ${index ?? 0} failed domain validation: ${err.message}`,
        { field: 'snapshots', index, cause: err },
      );
    }
    throw err;
  }
}

/**
 * Validates the full batch of snapshots supplied to the computation
 * engine: must be a non-empty array, and every member must itself be a
 * structurally valid, certified Snapshot entity (KR-02C Deliverable #8:
 * "snapshot integrity").
 *
 * @param {*} snapshots
 */
function validateComputationSnapshots(snapshots) {
  assert(Array.isArray(snapshots), 'Computation input must be an array of Snapshot entities', 'snapshots');
  assert(snapshots.length > 0, 'Computation input must contain at least one Snapshot', 'snapshots');
  snapshots.forEach((snapshot, index) => validateComputationSnapshot(snapshot, index));
}

/**
 * Validates a SnapshotComputationContext's shape (KR-02C Deliverable
 * #8: "execution context"). Called both by the context factory itself
 * (../context/snapshot.computation.context.js) and, defensively, by the
 * pipeline's validation stage.
 *
 * @param {*} context
 */
function validateSnapshotComputationContext(context) {
  assert(isPlainObject(context), 'SnapshotComputationContext must be an object', 'context');
  assert(isPlainObject(context.options), 'SnapshotComputationContext.options must be an object', 'context.options');
  assert(isNonEmptyString(context.scope), 'SnapshotComputationContext.scope must be a non-empty string', 'context.scope');
  assert(
    isPlainObject(context.parameters),
    'SnapshotComputationContext.parameters must be an object',
    'context.parameters',
  );
  assert(
    isIsoTimestamp(context.executedAt),
    'SnapshotComputationContext.executedAt must be an ISO-8601 timestamp',
    'context.executedAt',
  );
}

/**
 * Validates a bare computation-parameters object in isolation (KR-02C
 * Deliverable #8: "computation parameters") — used where a caller
 * passes parameters independently of a full context, e.g. when a rule
 * or aggregation step receives just its own parameter slice.
 *
 * @param {*} parameters
 */
function validateComputationParameters(parameters) {
  assert(isPlainObject(parameters), 'Computation parameters must be an object', 'parameters');
}

/**
 * Top-level "input consistency" validator (KR-02C Deliverable #8): the
 * single entry point the pipeline's validation stage and the engine's
 * public `validate`/`compute` methods call. Checks that the snapshot
 * batch and the context are each individually valid, and that they are
 * mutually consistent — every snapshot's own `scope` must match the
 * context's `scope`, since a computation is confined to one evaluation
 * scope at a time (KR-02C Mission: "evaluation scope").
 *
 * @param {*} snapshots
 * @param {*} context
 */
function validateComputationInput(snapshots, context) {
  validateComputationSnapshots(snapshots);
  validateSnapshotComputationContext(context);
  snapshots.forEach((snapshot, index) => {
    assert(
      snapshot.scope === context.scope,
      `Snapshot at index ${index} has scope "${snapshot.scope}" which does not match context scope "${context.scope}"`,
      'snapshots[].scope',
    );
  });
}

module.exports = {
  validateComputationInput,
  validateComputationSnapshots,
  validateComputationSnapshot,
  validateSnapshotComputationContext,
  validateComputationParameters,
};
