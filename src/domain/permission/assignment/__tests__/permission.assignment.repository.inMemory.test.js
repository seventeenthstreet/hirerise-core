'use strict';

/**
 * @file src/domain/permission/assignment/__tests__/permission.assignment.repository.inMemory.test.js
 *
 * WP-ADMIN-04F-06 — Enterprise Permission Assignment Services
 */

const { RESOURCES, ACTIONS } = require('../../permission.constants');
const { createAssignment } = require('../permission.assignment.model');
const { InMemoryAssignmentRepository } = require('../repository/permission.assignment.repository.inMemory');
const { DuplicateAssignmentError, AssignmentNotFoundError } = require('../permission.assignment.errors');

function makeAssignment(overrides = {}) {
  return createAssignment({
    principalId: overrides.principalId ?? 'u-1',
    resource: overrides.resource ?? RESOURCES.JOB_LISTING,
    action: overrides.action ?? ACTIONS.VIEW,
  });
}

describe('InMemoryAssignmentRepository', () => {
  test('create() stores an Assignment retrievable via find()', async () => {
    const repo = new InMemoryAssignmentRepository();
    const assignment = makeAssignment();
    await repo.create(assignment);
    const found = await repo.find(assignment.assignmentIdentity);
    expect(found).toEqual(assignment);
  });

  test('create() throws DuplicateAssignmentError for an existing identity', async () => {
    const repo = new InMemoryAssignmentRepository();
    const assignment = makeAssignment();
    await repo.create(assignment);
    await expect(repo.create(assignment)).rejects.toThrow(DuplicateAssignmentError);
  });

  test('find() returns null for a missing identity', async () => {
    const repo = new InMemoryAssignmentRepository();
    expect(await repo.find('nope::nope:nope')).toBeNull();
  });

  test('get() throws AssignmentNotFoundError for a missing identity', async () => {
    const repo = new InMemoryAssignmentRepository();
    await expect(repo.get('nope::nope:nope')).rejects.toThrow(AssignmentNotFoundError);
  });

  test('get() returns the Assignment when it exists', async () => {
    const repo = new InMemoryAssignmentRepository();
    const assignment = makeAssignment();
    await repo.create(assignment);
    expect(await repo.get(assignment.assignmentIdentity)).toEqual(assignment);
  });

  test('delete() removes an existing Assignment and returns true', async () => {
    const repo = new InMemoryAssignmentRepository();
    const assignment = makeAssignment();
    await repo.create(assignment);
    expect(await repo.delete(assignment.assignmentIdentity)).toBe(true);
    expect(await repo.find(assignment.assignmentIdentity)).toBeNull();
  });

  test('delete() is safe (returns false) for a missing identity', async () => {
    const repo = new InMemoryAssignmentRepository();
    expect(await repo.delete('nope::nope:nope')).toBe(false);
  });

  test('findByPrincipal() returns only that principal\'s Assignments', async () => {
    const repo = new InMemoryAssignmentRepository();
    const a1 = makeAssignment({ principalId: 'u-1', resource: RESOURCES.JOB_LISTING, action: ACTIONS.VIEW });
    const a2 = makeAssignment({ principalId: 'u-1', resource: RESOURCES.SKILL, action: ACTIONS.UPDATE });
    const a3 = makeAssignment({ principalId: 'u-2', resource: RESOURCES.JOB_LISTING, action: ACTIONS.VIEW });
    await repo.create(a1);
    await repo.create(a2);
    await repo.create(a3);
    const results = await repo.findByPrincipal('u-1');
    expect(results).toHaveLength(2);
    expect(results.map((a) => a.assignmentIdentity).sort()).toEqual([a1.assignmentIdentity, a2.assignmentIdentity].sort());
  });

  test('findByPermission() returns only Assignments of that Permission, across principals', async () => {
    const repo = new InMemoryAssignmentRepository();
    const a1 = makeAssignment({ principalId: 'u-1', resource: RESOURCES.JOB_LISTING, action: ACTIONS.VIEW });
    const a2 = makeAssignment({ principalId: 'u-2', resource: RESOURCES.JOB_LISTING, action: ACTIONS.VIEW });
    const a3 = makeAssignment({ principalId: 'u-1', resource: RESOURCES.SKILL, action: ACTIONS.UPDATE });
    await repo.create(a1);
    await repo.create(a2);
    await repo.create(a3);
    const results = await repo.findByPermission(a1.permissionIdentity);
    expect(results).toHaveLength(2);
  });

  test('count() reflects the number of stored Assignments', async () => {
    const repo = new InMemoryAssignmentRepository();
    expect(await repo.count()).toBe(0);
    await repo.create(makeAssignment({ principalId: 'u-1' }));
    await repo.create(makeAssignment({ principalId: 'u-2' }));
    expect(await repo.count()).toBe(2);
  });
});
