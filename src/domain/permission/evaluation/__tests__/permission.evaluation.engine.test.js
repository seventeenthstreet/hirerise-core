'use strict';

/**
 * @file src/domain/permission/evaluation/__tests__/permission.evaluation.engine.test.js
 *
 * WP-ADMIN-04F-05 — Authorization Evaluation Engine
 *
 * Exercises AuthorizationEvaluationEngine against a fake, constructor-
 * injected Registry (never a real Repository, never Supabase) — mirrors
 * ../../governance/__tests__/permission.governance.service.test.js's own
 * "fake satisfying the method surface" convention, scoped to the one
 * Registry method the Engine actually calls: `getPermissionByIdentity`.
 */

const { RESOURCES, ACTIONS, PERMISSION_CATEGORIES, PERMISSION_STATUS, AUTHORIZATION_DECISIONS } = require('../../permission.constants');
const { AuthorizationEvaluationEngine } = require('../permission.evaluation.engine');
const {
  PermissionNotFoundError,
  PermissionNotEvaluableError,
  AuthorizationContextError,
  UnsupportedEvaluationError,
} = require('../permission.evaluation.errors');
const { InvalidResourceError, InvalidActionError } = require('../../permission.errors');

const { PROPOSED, APPROVED, PUBLISHED, ADOPTED, DEPRECATED, RETIRED } = PERMISSION_STATUS;

function makeEntry(overrides = {}) {
  const resource = overrides.resource ?? RESOURCES.JOB_LISTING;
  const action = overrides.action ?? ACTIONS.VIEW;
  const identity = overrides.identity ?? `${resource}:${action}`;
  return {
    id: overrides.id ?? 'p-1',
    identity,
    name: identity,
    resource,
    action,
    category: overrides.category ?? PERMISSION_CATEGORIES.JOBS,
    status: overrides.status ?? PUBLISHED,
    description: overrides.description ?? 'A permission',
    capabilityOwner: overrides.capabilityOwner ?? null,
    lifecycleStage: overrides.lifecycleStage ?? { status: overrides.status ?? PUBLISHED, label: 'Published', stageIndex: 2, isTerminal: false },
    createdAt: overrides.createdAt ?? '2026-08-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-08-01T00:00:00.000Z',
  };
}

/**
 * A minimal fake satisfying only the Registry surface the Engine
 * consumes: `getPermissionByIdentity`. Never a repository, never
 * Supabase.
 */
function makeFakeRegistry(entries = []) {
  return {
    async getPermissionByIdentity(identity) {
      return entries.find((e) => e.identity === identity) ?? null;
    },
    // present to prove the Engine never calls it (Registry write
    // passthrough belongs to Governance, not Evaluation)
    async applyLifecycleTransition() {
      throw new Error('AuthorizationEvaluationEngine must never call applyLifecycleTransition');
    },
  };
}

describe('AuthorizationEvaluationEngine.evaluate', () => {
  test('Allow: a published Permission produces a deterministic Allow decision', async () => {
    const entry = makeEntry({ status: PUBLISHED });
    const engine = new AuthorizationEvaluationEngine(makeFakeRegistry([entry]));

    const { decision, explanation } = await engine.evaluate({ userId: 'u-1', resource: entry.resource, action: entry.action });

    expect(decision.outcome).toBe(AUTHORIZATION_DECISIONS.ALLOW);
    expect(decision.context).toMatchObject({ userId: 'u-1', resource: entry.resource, action: entry.action });
    expect(typeof decision.decidedAt).toBe('string');
    expect(explanation.permission).toBe(entry.identity);
    expect(explanation.decision).toBe(AUTHORIZATION_DECISIONS.ALLOW);
  });

  test('Allow: an adopted Permission also produces Allow', async () => {
    const entry = makeEntry({ status: ADOPTED });
    const engine = new AuthorizationEvaluationEngine(makeFakeRegistry([entry]));
    const { decision } = await engine.evaluate({ userId: 'u-1', resource: entry.resource, action: entry.action });
    expect(decision.outcome).toBe(AUTHORIZATION_DECISIONS.ALLOW);
  });

  test('Allow: a deprecated Permission still produces Allow, flagged in the explanation', async () => {
    const entry = makeEntry({ status: DEPRECATED });
    const engine = new AuthorizationEvaluationEngine(makeFakeRegistry([entry]));
    const { decision, explanation } = await engine.evaluate({ userId: 'u-1', resource: entry.resource, action: entry.action });
    expect(decision.outcome).toBe(AUTHORIZATION_DECISIONS.ALLOW);
    expect(explanation.metadata.deprecated).toBe(true);
    expect(decision.reason).toMatch(/deprecated/i);
  });

  test('Deny: a retired Permission produces a deterministic Deny decision', async () => {
    const entry = makeEntry({ status: RETIRED });
    const engine = new AuthorizationEvaluationEngine(makeFakeRegistry([entry]));
    const { decision } = await engine.evaluate({ userId: 'u-1', resource: entry.resource, action: entry.action });
    expect(decision.outcome).toBe(AUTHORIZATION_DECISIONS.DENY);
    expect(decision.reason).toMatch(/retired/i);
  });

  test.each([PROPOSED, APPROVED])('throws PermissionNotEvaluableError for status "%s"', async (status) => {
    const entry = makeEntry({ status });
    const engine = new AuthorizationEvaluationEngine(makeFakeRegistry([entry]));
    await expect(engine.evaluate({ userId: 'u-1', resource: entry.resource, action: entry.action })).rejects.toThrow(
      PermissionNotEvaluableError,
    );
  });

  test('throws PermissionNotFoundError when no Registry entry matches the identity', async () => {
    const engine = new AuthorizationEvaluationEngine(makeFakeRegistry([]));
    await expect(engine.evaluate({ userId: 'u-1', resource: RESOURCES.SKILL, action: ACTIONS.VIEW })).rejects.toThrow(
      PermissionNotFoundError,
    );
  });

  test('throws AuthorizationContextError for a missing userId', async () => {
    const entry = makeEntry();
    const engine = new AuthorizationEvaluationEngine(makeFakeRegistry([entry]));
    await expect(engine.evaluate({ resource: entry.resource, action: entry.action })).rejects.toThrow(AuthorizationContextError);
  });

  test('throws UnsupportedEvaluationError for a non-object request', async () => {
    const engine = new AuthorizationEvaluationEngine(makeFakeRegistry([]));
    await expect(engine.evaluate('nope')).rejects.toThrow(UnsupportedEvaluationError);
  });

  test('propagates the Domain layer error for an invalid Resource, without querying the Registry', async () => {
    const registry = makeFakeRegistry([]);
    const lookupSpy = jest.spyOn(registry, 'getPermissionByIdentity');
    const engine = new AuthorizationEvaluationEngine(registry);
    await expect(engine.evaluate({ userId: 'u-1', resource: 'not_a_real_resource', action: ACTIONS.VIEW })).rejects.toThrow(
      InvalidResourceError,
    );
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  test('propagates the Domain layer error for an invalid Action, without querying the Registry', async () => {
    const registry = makeFakeRegistry([]);
    const lookupSpy = jest.spyOn(registry, 'getPermissionByIdentity');
    const engine = new AuthorizationEvaluationEngine(registry);
    await expect(engine.evaluate({ userId: 'u-1', resource: RESOURCES.JOB_LISTING, action: 'not_a_real_action' })).rejects.toThrow(
      InvalidActionError,
    );
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  test('repeated evaluation of the same input is consistent (deterministic)', async () => {
    const entry = makeEntry({ status: PUBLISHED });
    const engine = new AuthorizationEvaluationEngine(makeFakeRegistry([entry]));
    const first = await engine.evaluate({ userId: 'u-1', resource: entry.resource, action: entry.action });
    const second = await engine.evaluate({ userId: 'u-1', resource: entry.resource, action: entry.action });
    expect(first.decision.outcome).toBe(second.decision.outcome);
    expect(first.explanation).toEqual(second.explanation);
  });

  test('decision and context objects are frozen (immutable output)', async () => {
    const entry = makeEntry({ status: PUBLISHED });
    const engine = new AuthorizationEvaluationEngine(makeFakeRegistry([entry]));
    const { decision, explanation } = await engine.evaluate({ userId: 'u-1', resource: entry.resource, action: entry.action });
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.context)).toBe(true);
    expect(Object.isFrozen(explanation)).toBe(true);
  });
});

describe('AuthorizationEvaluationEngine policy injection', () => {
  test('consumes an injected policy instead of the default, for both isEvaluable and decide', async () => {
    const entry = makeEntry({ status: PUBLISHED });
    const registry = makeFakeRegistry([entry]);

    // An inverted fake policy: denies everything the default policy would
    // Allow, and reports it not-evaluable. Proves the Engine defers
    // entirely to whatever policy it is given, rather than falling back
    // to hardcoded status handling.
    const invertedPolicy = {
      isEvaluable: () => false,
      decide: () => ({ outcome: AUTHORIZATION_DECISIONS.DENY, reason: 'denied by test policy' }),
    };

    const engine = new AuthorizationEvaluationEngine(registry, invertedPolicy);
    await expect(engine.evaluate({ userId: 'u-1', resource: entry.resource, action: entry.action })).rejects.toThrow(
      PermissionNotEvaluableError,
    );
  });

  test('a custom policy that allows a normally-error status changes the outcome', async () => {
    const entry = makeEntry({ status: PROPOSED });
    const registry = makeFakeRegistry([entry]);

    const permissivePolicy = {
      isEvaluable: () => true,
      decide: () => ({ outcome: AUTHORIZATION_DECISIONS.ALLOW, reason: 'allowed by test policy' }),
    };

    const engine = new AuthorizationEvaluationEngine(registry, permissivePolicy);
    const { decision } = await engine.evaluate({ userId: 'u-1', resource: entry.resource, action: entry.action });
    expect(decision.outcome).toBe(AUTHORIZATION_DECISIONS.ALLOW);
    expect(decision.reason).toBe('allowed by test policy');
  });

  test('defaults to defaultEvaluationPolicy when no policy is injected', async () => {
    const entry = makeEntry({ status: RETIRED });
    const engine = new AuthorizationEvaluationEngine(makeFakeRegistry([entry]));
    const { decision } = await engine.evaluate({ userId: 'u-1', resource: entry.resource, action: entry.action });
    // Matches DefaultEvaluationPolicy's Retired -> Deny mapping exactly.
    expect(decision.outcome).toBe(AUTHORIZATION_DECISIONS.DENY);
  });
});

describe('AuthorizationEvaluationEngine.evaluateBatch', () => {
  test('evaluates every request in order and returns matching results', async () => {
    const jobView = makeEntry({ resource: RESOURCES.JOB_LISTING, action: ACTIONS.VIEW, status: PUBLISHED });
    const skillUpdate = makeEntry({ resource: RESOURCES.SKILL, action: ACTIONS.UPDATE, status: ADOPTED });
    const engine = new AuthorizationEvaluationEngine(makeFakeRegistry([jobView, skillUpdate]));

    const results = await engine.evaluateBatch([
      { userId: 'u-1', resource: jobView.resource, action: jobView.action },
      { userId: 'u-1', resource: skillUpdate.resource, action: skillUpdate.action },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0].explanation.permission).toBe(jobView.identity);
    expect(results[1].explanation.permission).toBe(skillUpdate.identity);
  });

  test('rejects the whole batch up front on duplicate requests, without evaluating any', async () => {
    const entry = makeEntry({ status: PUBLISHED });
    const registry = makeFakeRegistry([entry]);
    const lookupSpy = jest.spyOn(registry, 'getPermissionByIdentity');
    const engine = new AuthorizationEvaluationEngine(registry);

    const request = { userId: 'u-1', resource: entry.resource, action: entry.action };
    await expect(engine.evaluateBatch([request, request])).rejects.toThrow(UnsupportedEvaluationError);
    expect(lookupSpy).not.toHaveBeenCalled();
  });
});
