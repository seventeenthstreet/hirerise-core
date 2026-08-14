'use strict';

/**
 * @file src/domain/permission/evaluation/__tests__/permission.evaluation.policy.test.js
 *
 * WP-ADMIN-04F-05 — Authorization Evaluation Engine (Architectural Refinement)
 */

const { RESOURCES, ACTIONS, PERMISSION_CATEGORIES, PERMISSION_STATUS, AUTHORIZATION_DECISIONS } = require('../../permission.constants');
const { DefaultEvaluationPolicy, defaultEvaluationPolicy } = require('../permission.evaluation.policy');

const { PROPOSED, APPROVED, PUBLISHED, ADOPTED, DEPRECATED, RETIRED } = PERMISSION_STATUS;

function makeEntry(status) {
  const resource = RESOURCES.JOB_LISTING;
  const action = ACTIONS.VIEW;
  const identity = `${resource}:${action}`;
  return {
    id: 'p-1',
    identity,
    name: identity,
    resource,
    action,
    category: PERMISSION_CATEGORIES.JOBS,
    status,
    description: null,
    capabilityOwner: null,
    lifecycleStage: { status, label: status, stageIndex: 0, isTerminal: status === RETIRED },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

describe('DefaultEvaluationPolicy.isEvaluable', () => {
  test.each([PROPOSED, APPROVED])('reports "%s" as not evaluable', (status) => {
    expect(new DefaultEvaluationPolicy().isEvaluable(status)).toBe(false);
  });

  test.each([PUBLISHED, ADOPTED, DEPRECATED, RETIRED])('reports "%s" as evaluable', (status) => {
    expect(new DefaultEvaluationPolicy().isEvaluable(status)).toBe(true);
  });
});

describe('DefaultEvaluationPolicy.decide', () => {
  test.each([PUBLISHED, ADOPTED])('Allows an entry with status "%s"', (status) => {
    const { outcome } = new DefaultEvaluationPolicy().decide(makeEntry(status));
    expect(outcome).toBe(AUTHORIZATION_DECISIONS.ALLOW);
  });

  test('Allows a deprecated entry, with the deprecation named in the reason', () => {
    const { outcome, reason } = new DefaultEvaluationPolicy().decide(makeEntry(DEPRECATED));
    expect(outcome).toBe(AUTHORIZATION_DECISIONS.ALLOW);
    expect(reason).toMatch(/deprecated/i);
  });

  test('Denies a retired entry, with retirement named in the reason', () => {
    const { outcome, reason } = new DefaultEvaluationPolicy().decide(makeEntry(RETIRED));
    expect(outcome).toBe(AUTHORIZATION_DECISIONS.DENY);
    expect(reason).toMatch(/retired/i);
  });

  test('is pure: repeated calls with an equivalent entry produce the same outcome and reason', () => {
    const a = new DefaultEvaluationPolicy().decide(makeEntry(PUBLISHED));
    const b = new DefaultEvaluationPolicy().decide(makeEntry(PUBLISHED));
    expect(a).toEqual(b);
  });
});

describe('defaultEvaluationPolicy singleton', () => {
  test('is an instance of DefaultEvaluationPolicy', () => {
    expect(defaultEvaluationPolicy).toBeInstanceOf(DefaultEvaluationPolicy);
  });
});
