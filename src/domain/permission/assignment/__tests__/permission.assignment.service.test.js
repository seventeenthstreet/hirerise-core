'use strict';

/**
 * @file src/domain/permission/assignment/__tests__/permission.assignment.service.test.js
 *
 * WP-ADMIN-04F-06 — Enterprise Permission Assignment Services
 *
 * Exercises PermissionAssignmentService against fake, constructor-
 * injected Registry and Evaluation Engine collaborators (never a real
 * Repository, never Supabase) — mirrors
 * ../../evaluation/__tests__/permission.evaluation.engine.test.js's own
 * "fake satisfying the method surface" convention.
 */

const { RESOURCES, ACTIONS, PERMISSION_CATEGORIES, PERMISSION_STATUS, AUTHORIZATION_DECISIONS } = require('../../permission.constants');
const { InvalidResourceError } = require('../../permission.errors');
const {
  PermissionNotFoundError,
  PermissionNotEvaluableError,
} = require('../../evaluation/permission.evaluation.errors');
const { PermissionAssignmentService } = require('../permission.assignment.service');
const { InMemoryAssignmentRepository } = require('../repository/permission.assignment.repository.inMemory');
const {
  InvalidAssignmentError,
  PermissionNotAssignableError,
} = require('../permission.assignment.errors');

const { PROPOSED, PUBLISHED, ADOPTED, DEPRECATED, RETIRED } = PERMISSION_STATUS;

function makeEntry(overrides = {}) {
  const resource = overrides.resource ?? RESOURCES.JOB_LISTING;
  const action = overrides.action ?? ACTIONS.VIEW;
  const identity = `${resource}:${action}`;
  return {
    id: 'p-1',
    identity,
    name: identity,
    resource,
    action,
    category: PERMISSION_CATEGORIES.JOBS,
    status: overrides.status ?? PUBLISHED,
    description: null,
    capabilityOwner: null,
    lifecycleStage: { status: overrides.status ?? PUBLISHED, label: 'x', stageIndex: 0, isTerminal: false },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

function makeFakeRegistry(entries = []) {
  return {
    async getPermissionByIdentity(identity) {
      return entries.find((e) => e.identity === identity) ?? null;
    },
  };
}

/**
 * A fake Evaluation Engine whose `evaluate()` behavior is controlled
 * per-test — either resolves with a given decision/explanation, or
 * rejects with a given error. `jest.fn()`-wrapped so tests can assert on
 * call arguments (proving the Service passes principalId as `userId`)
 * and on whether `evaluate()` was even called.
 */
function makeFakeEvaluationEngine(behavior) {
  return { evaluate: jest.fn(behavior) };
}

function resolvedEvaluation(outcome = AUTHORIZATION_DECISIONS.ALLOW) {
  return async () => ({
    decision: { outcome, context: {}, reason: 'irrelevant to Assignment', decidedAt: new Date().toISOString() },
    explanation: { permission: 'x', resource: 'x', action: 'x', decision: outcome, reason: 'irrelevant', metadata: {} },
  });
}

describe('PermissionAssignmentService.assignPermission', () => {
  test('assigns a Permission whose status the Assignment Policy allows', async () => {
    const entry = makeEntry({ status: PUBLISHED });
    const registry = makeFakeRegistry([entry]);
    const evaluationEngine = makeFakeEvaluationEngine(resolvedEvaluation());
    const service = new PermissionAssignmentService(registry, evaluationEngine, new InMemoryAssignmentRepository());

    const assignment = await service.assignPermission({ principalId: 'u-1', resource: entry.resource, action: entry.action });

    expect(assignment.principalId).toBe('u-1');
    expect(assignment.permissionIdentity).toBe(entry.identity);
    expect(evaluationEngine.evaluate).toHaveBeenCalledWith({ userId: 'u-1', resource: entry.resource, action: entry.action });
  });

  test('is idempotent: a second identical call returns the same Assignment without creating a duplicate', async () => {
    const entry = makeEntry({ status: ADOPTED });
    const registry = makeFakeRegistry([entry]);
    const evaluationEngine = makeFakeEvaluationEngine(resolvedEvaluation());
    const repository = new InMemoryAssignmentRepository();
    const createSpy = jest.spyOn(repository, 'create');
    const service = new PermissionAssignmentService(registry, evaluationEngine, repository);

    const request = { principalId: 'u-1', resource: entry.resource, action: entry.action };
    const first = await service.assignPermission(request);
    const second = await service.assignPermission(request);

    expect(second).toEqual(first);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(await repository.count()).toBe(1);
  });

  test('ignores the Evaluation Decision outcome entirely — a Deny decision does not block an otherwise-assignable status', async () => {
    // Deliberately proves WP-ADMIN-04F-06's review point 1: Assignment
    // must not branch on Allow/Deny. This fake Evaluation Engine resolves
    // successfully with a Deny outcome for a PUBLISHED (assignable)
    // Permission — the assignment must still succeed, because
    // assignability comes from AssignmentPolicy + Registry status, not
    // from this decision.
    const entry = makeEntry({ status: PUBLISHED });
    const registry = makeFakeRegistry([entry]);
    const evaluationEngine = makeFakeEvaluationEngine(resolvedEvaluation(AUTHORIZATION_DECISIONS.DENY));
    const service = new PermissionAssignmentService(registry, evaluationEngine, new InMemoryAssignmentRepository());

    const assignment = await service.assignPermission({ principalId: 'u-1', resource: entry.resource, action: entry.action });
    expect(assignment).toBeTruthy();
  });

  test('throws PermissionNotAssignableError when Evaluation reports the Permission does not exist', async () => {
    const registry = makeFakeRegistry([]);
    const evaluationEngine = makeFakeEvaluationEngine(async () => {
      throw new PermissionNotFoundError('job_listing:view');
    });
    const service = new PermissionAssignmentService(registry, evaluationEngine, new InMemoryAssignmentRepository());

    await expect(
      service.assignPermission({ principalId: 'u-1', resource: RESOURCES.JOB_LISTING, action: ACTIONS.VIEW }),
    ).rejects.toThrow(PermissionNotAssignableError);
  });

  test('throws PermissionNotAssignableError when Evaluation reports the Permission is not evaluable (e.g. Proposed)', async () => {
    const entry = makeEntry({ status: PROPOSED });
    const registry = makeFakeRegistry([entry]);
    const evaluationEngine = makeFakeEvaluationEngine(async () => {
      throw new PermissionNotEvaluableError(entry.identity, PROPOSED);
    });
    const service = new PermissionAssignmentService(registry, evaluationEngine, new InMemoryAssignmentRepository());

    await expect(
      service.assignPermission({ principalId: 'u-1', resource: entry.resource, action: entry.action }),
    ).rejects.toThrow(PermissionNotAssignableError);
  });

  test.each([RETIRED, DEPRECATED])(
    'throws PermissionNotAssignableError for status "%s" even though Evaluation would allow evaluating it',
    async (status) => {
      const entry = makeEntry({ status });
      const registry = makeFakeRegistry([entry]);
      // Evaluation succeeds (this status is evaluable under DefaultEvaluationPolicy) —
      // the rejection must come from the Assignment Policy, not from Evaluation.
      const evaluationEngine = makeFakeEvaluationEngine(resolvedEvaluation());
      const service = new PermissionAssignmentService(registry, evaluationEngine, new InMemoryAssignmentRepository());

      await expect(
        service.assignPermission({ principalId: 'u-1', resource: entry.resource, action: entry.action }),
      ).rejects.toThrow(PermissionNotAssignableError);
    },
  );

  test('propagates a Domain-layer validation error (e.g. invalid Resource) unchanged, not wrapped', async () => {
    const registry = makeFakeRegistry([]);
    const evaluationEngine = makeFakeEvaluationEngine(async () => {
      throw new InvalidResourceError('not_a_real_resource');
    });
    const service = new PermissionAssignmentService(registry, evaluationEngine, new InMemoryAssignmentRepository());

    await expect(
      service.assignPermission({ principalId: 'u-1', resource: 'not_a_real_resource', action: ACTIONS.VIEW }),
    ).rejects.toThrow(InvalidResourceError);
  });

  test('throws InvalidAssignmentError for a malformed request without calling Evaluation at all', async () => {
    const registry = makeFakeRegistry([]);
    const evaluationEngine = makeFakeEvaluationEngine(resolvedEvaluation());
    const service = new PermissionAssignmentService(registry, evaluationEngine, new InMemoryAssignmentRepository());

    await expect(service.assignPermission({ principalId: '', resource: 'x', action: 'y' })).rejects.toThrow(InvalidAssignmentError);
    expect(evaluationEngine.evaluate).not.toHaveBeenCalled();
  });
});

describe('PermissionAssignmentService.revokePermission', () => {
  test('revokes an existing Assignment and returns true', async () => {
    const entry = makeEntry({ status: PUBLISHED });
    const registry = makeFakeRegistry([entry]);
    const evaluationEngine = makeFakeEvaluationEngine(resolvedEvaluation());
    const service = new PermissionAssignmentService(registry, evaluationEngine, new InMemoryAssignmentRepository());

    const request = { principalId: 'u-1', resource: entry.resource, action: entry.action };
    await service.assignPermission(request);
    expect(await service.revokePermission(request)).toBe(true);
    expect(await service.hasAssignment(request)).toBe(false);
  });

  test('is safe (returns false, does not throw) when revoking a non-existent Assignment', async () => {
    const registry = makeFakeRegistry([]);
    const evaluationEngine = makeFakeEvaluationEngine(resolvedEvaluation());
    const service = new PermissionAssignmentService(registry, evaluationEngine, new InMemoryAssignmentRepository());

    await expect(
      service.revokePermission({ principalId: 'u-1', resource: RESOURCES.JOB_LISTING, action: ACTIONS.VIEW }),
    ).resolves.toBe(false);
  });

  test('repeated revocation is safe', async () => {
    const entry = makeEntry({ status: PUBLISHED });
    const registry = makeFakeRegistry([entry]);
    const evaluationEngine = makeFakeEvaluationEngine(resolvedEvaluation());
    const service = new PermissionAssignmentService(registry, evaluationEngine, new InMemoryAssignmentRepository());
    const request = { principalId: 'u-1', resource: entry.resource, action: entry.action };

    await service.assignPermission(request);
    expect(await service.revokePermission(request)).toBe(true);
    expect(await service.revokePermission(request)).toBe(false);
  });
});

describe('PermissionAssignmentService.hasAssignment', () => {
  test('reflects assignment state without calling Evaluation or Registry', async () => {
    const registry = makeFakeRegistry([]);
    const evaluationEngine = makeFakeEvaluationEngine(resolvedEvaluation());
    const registrySpy = jest.spyOn(registry, 'getPermissionByIdentity');
    const service = new PermissionAssignmentService(registry, evaluationEngine, new InMemoryAssignmentRepository());

    const result = await service.hasAssignment({ principalId: 'u-1', resource: RESOURCES.JOB_LISTING, action: ACTIONS.VIEW });
    expect(result).toBe(false);
    expect(evaluationEngine.evaluate).not.toHaveBeenCalled();
    expect(registrySpy).not.toHaveBeenCalled();
  });
});

describe('PermissionAssignmentService discovery', () => {
  test('getAssignments() returns only the given principal\'s Assignments', async () => {
    const jobEntry = makeEntry({ resource: RESOURCES.JOB_LISTING, action: ACTIONS.VIEW, status: PUBLISHED });
    const skillEntry = makeEntry({ resource: RESOURCES.SKILL, action: ACTIONS.UPDATE, status: ADOPTED });
    const registry = makeFakeRegistry([jobEntry, skillEntry]);
    const evaluationEngine = makeFakeEvaluationEngine(resolvedEvaluation());
    const service = new PermissionAssignmentService(registry, evaluationEngine, new InMemoryAssignmentRepository());

    await service.assignPermission({ principalId: 'u-1', resource: jobEntry.resource, action: jobEntry.action });
    await service.assignPermission({ principalId: 'u-1', resource: skillEntry.resource, action: skillEntry.action });
    await service.assignPermission({ principalId: 'u-2', resource: jobEntry.resource, action: jobEntry.action });

    const results = await service.getAssignments({ principalId: 'u-1' });
    expect(results).toHaveLength(2);
  });

  test('getAssignments() validates its request shape', async () => {
    const service = new PermissionAssignmentService(makeFakeRegistry([]), makeFakeEvaluationEngine(resolvedEvaluation()), new InMemoryAssignmentRepository());
    await expect(service.getAssignments({})).rejects.toThrow(InvalidAssignmentError);
  });

  test('listAssignments() returns Assignments of a Permission across principals', async () => {
    const entry = makeEntry({ status: PUBLISHED });
    const registry = makeFakeRegistry([entry]);
    const evaluationEngine = makeFakeEvaluationEngine(resolvedEvaluation());
    const service = new PermissionAssignmentService(registry, evaluationEngine, new InMemoryAssignmentRepository());

    await service.assignPermission({ principalId: 'u-1', resource: entry.resource, action: entry.action });
    await service.assignPermission({ principalId: 'u-2', resource: entry.resource, action: entry.action });

    const results = await service.listAssignments({ resource: entry.resource, action: entry.action });
    expect(results).toHaveLength(2);
  });

  test('listAssignments() validates its request shape', async () => {
    const service = new PermissionAssignmentService(makeFakeRegistry([]), makeFakeEvaluationEngine(resolvedEvaluation()), new InMemoryAssignmentRepository());
    await expect(service.listAssignments({ resource: 'job_listing' })).rejects.toThrow(InvalidAssignmentError);
    await expect(service.listAssignments(null)).rejects.toThrow(InvalidAssignmentError);
  });
});
