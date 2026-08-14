'use strict';

/**
 * @file src/domain/permission/assignment/__tests__/permission.assignment.validation.test.js
 *
 * WP-ADMIN-04F-06 — Enterprise Permission Assignment Services
 */

const { validatePermissionRequestShape, validatePrincipalRequestShape } = require('../permission.assignment.validation');
const { InvalidAssignmentError } = require('../permission.assignment.errors');

describe('validatePermissionRequestShape', () => {
  test('accepts a well-formed request', () => {
    expect(() => validatePermissionRequestShape({ principalId: 'u-1', resource: 'job_listing', action: 'view' })).not.toThrow();
  });

  test.each([null, undefined, 'string', 42, []])('rejects non-object request: %p', (value) => {
    expect(() => validatePermissionRequestShape(value)).toThrow(InvalidAssignmentError);
  });

  test('rejects missing principalId', () => {
    expect(() => validatePermissionRequestShape({ resource: 'job_listing', action: 'view' })).toThrow(InvalidAssignmentError);
  });

  test('rejects empty-string resource', () => {
    expect(() => validatePermissionRequestShape({ principalId: 'u-1', resource: '', action: 'view' })).toThrow(InvalidAssignmentError);
  });

  test('rejects non-string action', () => {
    expect(() => validatePermissionRequestShape({ principalId: 'u-1', resource: 'job_listing', action: 123 })).toThrow(
      InvalidAssignmentError,
    );
  });
});

describe('validatePrincipalRequestShape', () => {
  test('accepts a well-formed request', () => {
    expect(() => validatePrincipalRequestShape({ principalId: 'u-1' })).not.toThrow();
  });

  test.each([null, undefined, 'string', 42, []])('rejects non-object request: %p', (value) => {
    expect(() => validatePrincipalRequestShape(value)).toThrow(InvalidAssignmentError);
  });

  test('rejects missing principalId', () => {
    expect(() => validatePrincipalRequestShape({})).toThrow(InvalidAssignmentError);
  });
});
