'use strict';

/**
 * @file core/src/modules/snapshot-intelligence/computation/rules/snapshot.computation.ruleEngine.js
 *
 * KR-02C — Snapshot Computation Engine
 *
 * The rule execution framework, per KR-02C's "Computation Rules"
 * deliverable. Supports:
 *
 *   - ordered execution   — rules run in the exact array order supplied
 *   - deterministic evaluation — no I/O, no randomness inside this
 *                                  module; the same (rules, input,
 *                                  context) always produces the same
 *                                  outcome list
 *   - rule isolation       — one rule throwing does not stop the others
 *                              from running; the failure is captured and
 *                              reported, not swallowed and not fatal to
 *                              the batch
 *   - rule composition      — `createRuleSet` accepts any array of
 *                              contract-compliant rules, including rule
 *                              sets built by composing/filtering other
 *                              rule sets
 *
 * "Do NOT implement business-specific rules yet. Only the framework."
 * (KR-02C Mission): nothing in this file evaluates any HireRise-specific
 * concept. It only orchestrates whatever rule instances a caller
 * supplies.
 */

const { SnapshotRuleExecutionError } = require('../errors/snapshot.computation.errors');

/**
 * Runtime, duck-typed contract-compliance check — mirrors the certified
 * repository layer's `assertRepositoryContractCompliance` convention.
 * A rule need not extend SnapshotComputationRule; it must only expose
 * `supports` and `evaluate` as functions.
 *
 * @param {*} rule
 * @param {number} [index]
 */
function assertRuleContractCompliance(rule, index) {
  const label = rule && rule.id ? rule.id : `rules[${index ?? '?'}]`;
  if (!rule || typeof rule !== 'object') {
    throw new SnapshotRuleExecutionError(`${label} is not a valid computation rule object`, { index });
  }
  if (typeof rule.supports !== 'function') {
    throw new SnapshotRuleExecutionError(`${label} does not implement supports()`, { index, ruleId: rule.id });
  }
  if (typeof rule.evaluate !== 'function') {
    throw new SnapshotRuleExecutionError(`${label} does not implement evaluate()`, { index, ruleId: rule.id });
  }
}

/**
 * Builds a validated, ordered rule set from an array of rules. The
 * returned array is frozen (order and membership fixed) but the rule
 * instances themselves are not — rule statelessness is a contract the
 * rule author is responsible for (KR-02C Mission: "Rules shall be
 * stateless"), not something this framework can enforce at runtime.
 *
 * @param {Array<SnapshotComputationRule|Object>} rules
 * @returns {ReadonlyArray<Object>}
 */
function createRuleSet(rules) {
  if (!Array.isArray(rules)) {
    throw new SnapshotRuleExecutionError('createRuleSet requires an array of rules', { received: typeof rules });
  }
  rules.forEach((rule, index) => assertRuleContractCompliance(rule, index));
  const ids = rules.map((r) => r.id);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate !== undefined) {
    throw new SnapshotRuleExecutionError(`Duplicate rule id "${duplicate}" in rule set`, { ruleId: duplicate });
  }
  return Object.freeze([...rules]);
}

/**
 * @typedef {Object} RuleExecutionOutcome
 * @property {string} ruleId
 * @property {'EVALUATED'|'SKIPPED'|'FAILED'} status
 * @property {*} [value] - present when status is EVALUATED
 * @property {{message: string, code: string}} [error] - present when
 * status is FAILED
 */

/**
 * Executes every rule in `ruleSet`, in order, against `input` and
 * `context`. A rule whose `supports(input, context)` returns false is
 * recorded as SKIPPED and not evaluated. A rule whose `evaluate` throws
 * is recorded as FAILED (rule isolation: execution continues with the
 * next rule) with the underlying error captured, and — if the thrown
 * error is not already a SnapshotRuleExecutionError — wrapped in one so
 * every failure in the outcome list belongs to the same error identity.
 *
 * This function itself never throws for an individual rule's failure;
 * it only throws if `ruleSet`/`input`/`context` themselves are
 * malformed, which is a caller/wiring error rather than a rule-runtime
 * one.
 *
 * @param {ReadonlyArray<Object>} ruleSet
 * @param {Object} input
 * @param {import('../context/snapshot.computation.context').SnapshotComputationContext} context
 * @returns {RuleExecutionOutcome[]}
 */
function executeRules(ruleSet, input, context) {
  if (!Array.isArray(ruleSet)) {
    throw new SnapshotRuleExecutionError('executeRules requires a rule set built by createRuleSet', { received: typeof ruleSet });
  }

  return ruleSet.map((rule) => {
    let supported;
    try {
      supported = rule.supports(input, context);
    } catch (err) {
      const wrapped = err instanceof SnapshotRuleExecutionError
        ? err
        : new SnapshotRuleExecutionError(
          `Rule "${rule.id}" threw during supports(): ${err.message}`,
          { ruleId: rule.id, cause: err },
        );
      return { ruleId: rule.id, status: 'FAILED', error: { message: wrapped.message, code: wrapped.code } };
    }

    if (!supported) {
      return { ruleId: rule.id, status: 'SKIPPED' };
    }

    try {
      const value = rule.evaluate(input, context);
      return { ruleId: rule.id, status: 'EVALUATED', value };
    } catch (err) {
      const wrapped = err instanceof SnapshotRuleExecutionError
        ? err
        : new SnapshotRuleExecutionError(
          `Rule "${rule.id}" threw during evaluate(): ${err.message}`,
          { ruleId: rule.id, cause: err },
        );
      return { ruleId: rule.id, status: 'FAILED', error: { message: wrapped.message, code: wrapped.code } };
    }
  });
}

/**
 * Composes multiple rule sets into a single ordered rule set (KR-02C
 * Deliverable #5: "rule composition"). Later sets' rules are appended
 * after earlier sets', preserving each input set's own internal order.
 * Re-validates the combined result through `createRuleSet` so composed
 * duplicate ids are still caught.
 *
 * @param {Array<ReadonlyArray<Object>>} ruleSets
 * @returns {ReadonlyArray<Object>}
 */
function composeRuleSets(ruleSets) {
  if (!Array.isArray(ruleSets)) {
    throw new SnapshotRuleExecutionError('composeRuleSets requires an array of rule sets', { received: typeof ruleSets });
  }
  return createRuleSet(ruleSets.flatMap((set) => [...set]));
}

module.exports = {
  assertRuleContractCompliance,
  createRuleSet,
  executeRules,
  composeRuleSets,
};
