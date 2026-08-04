'use strict';

/**
 * @file core/src/modules/snapshot-intelligence/computation/__tests__/computation.rules.test.js
 * KR-02C — Snapshot Computation Engine — Rule Contract & Rule Execution
 * Framework tests.
 */

const { SnapshotComputationRule } = require('../rules/snapshot.computation.ruleContract');
const {
  assertRuleContractCompliance,
  createRuleSet,
  executeRules,
  composeRuleSets,
} = require('../rules/snapshot.computation.ruleEngine');
const { SnapshotRuleExecutionError } = require('../errors/snapshot.computation.errors');
const { buildComputationContext } = require('../testHelpers/computation.fixtures');

class AlwaysSupportsRule extends SnapshotComputationRule {
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

class NeverSupportsRule extends SnapshotComputationRule {
  constructor(id) {
    super({ id });
  }

  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  supports(input, context) {
    return false;
  }

  // eslint-disable-next-line class-methods-use-this
  evaluate() {
    return 'should never run';
  }
}

class ThrowingRule extends SnapshotComputationRule {
  constructor(id) {
    super({ id });
  }

  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  supports(input, context) {
    return true;
  }

  // eslint-disable-next-line class-methods-use-this
  evaluate() {
    throw new Error('rule blew up');
  }
}

describe('SnapshotComputationRule base contract', () => {
  it('assigns id from the id given, defaulting to the constructor name', () => {
    const rule = new AlwaysSupportsRule('my-rule', 1);
    expect(rule.id).toBe('my-rule');
    const anonymous = new (class extends SnapshotComputationRule {})();
    expect(anonymous.id).toBe(anonymous.constructor.name);
  });

  it('base supports()/evaluate() throw SnapshotRuleExecutionError when not overridden', () => {
    const rule = new SnapshotComputationRule({ id: 'base' });
    expect(() => rule.supports({}, {})).toThrow(SnapshotRuleExecutionError);
    expect(() => rule.evaluate({}, {})).toThrow(SnapshotRuleExecutionError);
  });
});

describe('assertRuleContractCompliance / createRuleSet', () => {
  it('accepts rules exposing supports() and evaluate()', () => {
    expect(() => assertRuleContractCompliance(new AlwaysSupportsRule('r1', 1))).not.toThrow();
  });

  it('rejects an object missing evaluate()', () => {
    expect(() => assertRuleContractCompliance({ id: 'bad', supports: () => true })).toThrow(SnapshotRuleExecutionError);
  });

  it('createRuleSet freezes an ordered, validated rule set', () => {
    const ruleSet = createRuleSet([new AlwaysSupportsRule('r1', 1), new AlwaysSupportsRule('r2', 2)]);
    expect(Object.isFrozen(ruleSet)).toBe(true);
    expect(ruleSet.map((r) => r.id)).toEqual(['r1', 'r2']);
  });

  it('createRuleSet rejects duplicate rule ids', () => {
    expect(() => createRuleSet([new AlwaysSupportsRule('dup', 1), new AlwaysSupportsRule('dup', 2)]))
      .toThrow(SnapshotRuleExecutionError);
  });

  it('createRuleSet rejects a non-array', () => {
    expect(() => createRuleSet('nope')).toThrow(SnapshotRuleExecutionError);
  });
});

describe('executeRules — ordered execution, isolation, skipping', () => {
  const context = buildComputationContext();

  it('executes rules in order and records EVALUATED outcomes', () => {
    const ruleSet = createRuleSet([new AlwaysSupportsRule('r1', 'a'), new AlwaysSupportsRule('r2', 'b')]);
    const outcomes = executeRules(ruleSet, {}, context);
    expect(outcomes).toEqual([
      { ruleId: 'r1', status: 'EVALUATED', value: 'a' },
      { ruleId: 'r2', status: 'EVALUATED', value: 'b' },
    ]);
  });

  it('records SKIPPED when supports() returns false', () => {
    const ruleSet = createRuleSet([new NeverSupportsRule('skip-me')]);
    const outcomes = executeRules(ruleSet, {}, context);
    expect(outcomes).toEqual([{ ruleId: 'skip-me', status: 'SKIPPED' }]);
  });

  it('isolates a failing rule — later rules still execute', () => {
    const ruleSet = createRuleSet([
      new ThrowingRule('boom'),
      new AlwaysSupportsRule('after', 'still-ran'),
    ]);
    const outcomes = executeRules(ruleSet, {}, context);
    expect(outcomes[0].status).toBe('FAILED');
    expect(outcomes[0].error.code).toBe('SNAPSHOT_RULE_EXECUTION_ERROR');
    expect(outcomes[1]).toEqual({ ruleId: 'after', status: 'EVALUATED', value: 'still-ran' });
  });

  it('is deterministic — identical input produces identical outcome list', () => {
    const ruleSet = createRuleSet([new AlwaysSupportsRule('r1', 'a')]);
    const first = executeRules(ruleSet, { x: 1 }, context);
    const second = executeRules(ruleSet, { x: 1 }, context);
    expect(first).toEqual(second);
  });

  it('rejects a non-ruleSet argument', () => {
    expect(() => executeRules('nope', {}, context)).toThrow(SnapshotRuleExecutionError);
  });
});

describe('composeRuleSets — rule composition', () => {
  it('appends later sets after earlier ones, preserving internal order', () => {
    const setA = createRuleSet([new AlwaysSupportsRule('a1', 1), new AlwaysSupportsRule('a2', 2)]);
    const setB = createRuleSet([new AlwaysSupportsRule('b1', 3)]);
    const composed = composeRuleSets([setA, setB]);
    expect(composed.map((r) => r.id)).toEqual(['a1', 'a2', 'b1']);
  });

  it('rejects composed sets with a duplicate id across sets', () => {
    const setA = createRuleSet([new AlwaysSupportsRule('dup', 1)]);
    const setB = createRuleSet([new AlwaysSupportsRule('dup', 2)]);
    expect(() => composeRuleSets([setA, setB])).toThrow(SnapshotRuleExecutionError);
  });
});
