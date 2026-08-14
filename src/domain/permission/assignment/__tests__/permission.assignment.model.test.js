'use strict';

/**
 * @file src/domain/permission/assignment/__tests__/permission.assignment.model.test.js
 *
 * WP-ADMIN-04F-06 — Enterprise Permission Assignment Services
 */

const { RESOURCES, ACTIONS } = require('../../permission.constants');
const { createAssignment, buildAssignmentIdentity } = require('../permission.assignment.model');
const { InvalidAssignmentError } = require('../permission.assignment.errors');

describe('buildAssignmentIdentity', () => {
  test('is deterministic for the same inputs', () => {
    const a = buildAssignmentIdentity('u-1', 'job_listing:view');
    const b = buildAssignmentIdentity('u-1', 'job_listing:view');
    expect(a).toBe(b);
  });

  test('differs for different principals or permissions', () => {
    const a = buildAssignmentIdentity('u-1', 'job_listing:view');
    const b = buildAssignmentIdentity('u-2', 'job_listing:view');
    const c = buildAssignmentIdentity('u-1', 'job_listing:update');
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('createAssignment', () => {
  test('builds a well-formed, frozen Assignment', () => {
    const assignment = createAssignment({ principalId: 'u-1', resource: RESOURCES.JOB_LISTING, action: ACTIONS.VIEW });
    expect(assignment.principalId).toBe('u-1');
    expect(assignment.permissionIdentity).toBe(`${RESOURCES.JOB_LISTING}:${ACTIONS.VIEW}`);
    expect(assignment.assignmentIdentity).toBe(buildAssignmentIdentity('u-1', assignment.permissionIdentity));
    expect(typeof assignment.assignedAt).toBe('string');
    expect(Object.isFrozen(assignment)).toBe(true);
  });

  test('accepts an explicit assignedAt', () => {
    const assignment = createAssignment({
      principalId: 'u-1',
      resource: RESOURCES.JOB_LISTING,
      action: ACTIONS.VIEW,
      assignedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(assignment.assignedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  test.each([
    [{ resource: 'job_listing', action: 'view' }, 'missing principalId'],
    [{ principalId: '', resource: 'job_listing', action: 'view' }, 'empty principalId'],
    [{ principalId: 'u-1', action: 'view' }, 'missing resource'],
    [{ principalId: 'u-1', resource: 'job_listing' }, 'missing action'],
  ])('throws InvalidAssignmentError for %p (%s)', (input) => {
    expect(() => createAssignment(input)).toThrow(InvalidAssignmentError);
  });
});
