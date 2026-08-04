'use strict';

/**
 * @file core/src/modules/snapshot-intelligence/computation/rules/snapshot.computation.ruleContract.js
 *
 * KR-02C — Snapshot Computation Engine
 *
 * SnapshotComputationRule, per KR-02C's "Rule Contracts" deliverable:
 * the canonical contract every computation rule implements.
 *
 * Modeled as an abstract base class, the same deliberate choice the
 * certified repository layer made for its interfaces
 * (repository/interfaces/snapshot.repository.interfaces.js): a rule is
 * a *behavior* boundary (it does something with an input), not a
 * *value* boundary, so it is not a plain-object/factory-function
 * construction like the domain entities. Extending this class is
 * optional, not required — what actually matters is the runtime
 * method-presence check performed by
 * ../rules/snapshot.computation.ruleEngine.js's `assertRuleContractCompliance`,
 * mirroring the repository layer's own duck-typing convention. Extending
 * it is the recommended path because it gets a caller a clear
 * "not implemented" error for any method a subclass forgets, rather
 * than a silent `undefined is not a function`.
 *
 * Rules SHALL be stateless (KR-02C Mission): this base class holds no
 * mutable instance state beyond an optional identifying `id`/`description`
 * pair set once at construction and never written to again. A concrete
 * rule subclass must not accumulate state across `evaluate()` calls —
 * the rule execution framework may (and, per KR-02C's determinism exit
 * criterion, effectively must be able to) reuse a single rule instance
 * across many computation runs and rely on identical output for
 * identical input.
 */

const { SnapshotRuleExecutionError } = require('../errors/snapshot.computation.errors');

function notImplemented(className, methodName) {
  throw new SnapshotRuleExecutionError(
    `${className}.${methodName}() is not implemented`,
    'SNAPSHOT_RULE_METHOD_NOT_IMPLEMENTED',
    { className, methodName },
  );
}

class SnapshotComputationRule {
  /**
   * @param {Object} [meta]
   * @param {string} [meta.id] - stable rule identifier, used by the rule
   * execution framework and by diagnostics to attribute a result or an
   * error to exactly one rule
   * @param {string} [meta.description]
   */
  constructor({ id, description } = {}) {
    this.id = id ?? this.constructor.name;
    this.description = description ?? '';
  }

  /**
   * Returns whether this rule applies to the given normalized
   * computation input. Called once per rule, per computation run, by
   * the rule execution framework before `evaluate()` — a rule that does
   * not support a given input is skipped, not treated as a failure.
   *
   * @param {Object} input - normalized computation input (see
   * ../pipeline/snapshot.computation.pipeline.js's normalization stage)
   * @param {import('../context/snapshot.computation.context').SnapshotComputationContext} context
   * @returns {boolean}
   */
  // eslint-disable-next-line no-unused-vars
  supports(input, context) {
    notImplemented(this.constructor.name, 'supports');
  }

  /**
   * Deterministically evaluates this rule against the given input.
   * Must be a pure function of (input, context) — no I/O, no randomness,
   * no reliance on ambient state, no mutation of `input` or `context`
   * (both may be frozen; attempting to mutate either throws).
   *
   * @param {Object} input
   * @param {import('../context/snapshot.computation.context').SnapshotComputationContext} context
   * @returns {*} an opaque, rule-defined result
   */
  // eslint-disable-next-line no-unused-vars
  evaluate(input, context) {
    notImplemented(this.constructor.name, 'evaluate');
  }
}

module.exports = {
  SnapshotComputationRule,
};
