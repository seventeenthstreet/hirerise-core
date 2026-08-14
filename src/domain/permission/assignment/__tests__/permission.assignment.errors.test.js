'use strict';

/**
 * @file src/domain/permission/assignment/__tests__/permission.assignment.errors.test.js
 *
 * WP-ADMIN-04F-06 — Enterprise Permission Assignment Services
 */

const {
  PermissionAssignmentError,
  DuplicateAssignmentError,
  AssignmentNotFoundError,
  InvalidAssignmentError,
  PermissionNotAssignableError,
} = require('../permission.assignment.errors');

describe('permission.assignment.errors', () => {
  test('PermissionAssignmentError carries name, code and metadata', () => {
    const err = new PermissionAssignmentError('boom', 'SOME_CODE', { foo: 'bar' });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('PermissionAssignmentError');
    expect(err.code).toBe('SOME_CODE');
    expect(err.metadata).toEqual({ foo: 'bar' });
  });

  test('DuplicateAssignmentError extends PermissionAssignmentError and carries identity', () => {
    const err = new DuplicateAssignmentError('u-1::job_listing:view');
    expect(err).toBeInstanceOf(PermissionAssignmentError);
    expect(err.name).toBe('DuplicateAssignmentError');
    expect(err.code).toBe('ASSIGNMENT_DUPLICATE');
    expect(err.metadata.assignmentIdentity).toBe('u-1::job_listing:view');
  });

  test('AssignmentNotFoundError extends PermissionAssignmentError', () => {
    const err = new AssignmentNotFoundError('u-1::job_listing:view');
    expect(err).toBeInstanceOf(PermissionAssignmentError);
    expect(err.name).toBe('AssignmentNotFoundError');
    expect(err.code).toBe('ASSIGNMENT_NOT_FOUND');
  });

  test('InvalidAssignmentError extends PermissionAssignmentError', () => {
    const err = new InvalidAssignmentError('missing principalId');
    expect(err).toBeInstanceOf(PermissionAssignmentError);
    expect(err.name).toBe('InvalidAssignmentError');
    expect(err.code).toBe('ASSIGNMENT_INVALID_REQUEST');
    expect(err.message).toContain('missing principalId');
  });

  test('PermissionNotAssignableError carries identity and reason', () => {
    const err = new PermissionNotAssignableError('job_listing:view', 'status "retired" is not assignable');
    expect(err).toBeInstanceOf(PermissionAssignmentError);
    expect(err.name).toBe('PermissionNotAssignableError');
    expect(err.code).toBe('ASSIGNMENT_PERMISSION_NOT_ASSIGNABLE');
    expect(err.metadata).toMatchObject({
      permissionIdentity: 'job_listing:view',
      reason: 'status "retired" is not assignable',
    });
  });
});
