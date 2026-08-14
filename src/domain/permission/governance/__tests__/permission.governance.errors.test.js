'use strict';

/**
 * @file src/domain/permission/governance/__tests__/permission.governance.errors.test.js
 *
 * WP-ADMIN-04F-04 — Enterprise Permission Governance Services
 */

const {
  PermissionGovernanceError,
  InvalidLifecycleTransitionError,
  PermissionAlreadyPublishedError,
  PermissionAlreadyRetiredError,
  GovernanceValidationError,
  GovernanceConflictError,
} = require('../permission.governance.errors');

describe('PermissionGovernanceError', () => {
  it('carries a message, code, and metadata', () => {
    const error = new PermissionGovernanceError('boom', 'SOME_CODE', { foo: 'bar' });
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('boom');
    expect(error.code).toBe('SOME_CODE');
    expect(error.metadata).toEqual({ foo: 'bar' });
  });
});

describe('InvalidLifecycleTransitionError', () => {
  it('is a PermissionGovernanceError carrying fromStatus/toStatus', () => {
    const error = new InvalidLifecycleTransitionError('proposed', 'published', { id: 'p-1' });
    expect(error).toBeInstanceOf(PermissionGovernanceError);
    expect(error.name).toBe('InvalidLifecycleTransitionError');
    expect(error.code).toBe('GOVERNANCE_INVALID_LIFECYCLE_TRANSITION');
    expect(error.metadata).toEqual({ fromStatus: 'proposed', toStatus: 'published', id: 'p-1' });
  });
});

describe('PermissionAlreadyPublishedError', () => {
  it('is a PermissionGovernanceError carrying the identity', () => {
    const error = new PermissionAlreadyPublishedError('job_listing:view', { id: 'p-1' });
    expect(error).toBeInstanceOf(PermissionGovernanceError);
    expect(error.name).toBe('PermissionAlreadyPublishedError');
    expect(error.code).toBe('GOVERNANCE_PERMISSION_ALREADY_PUBLISHED');
    expect(error.metadata).toEqual({ identity: 'job_listing:view', id: 'p-1' });
  });
});

describe('PermissionAlreadyRetiredError', () => {
  it('is a PermissionGovernanceError carrying the identity', () => {
    const error = new PermissionAlreadyRetiredError('job_listing:view', { id: 'p-1' });
    expect(error).toBeInstanceOf(PermissionGovernanceError);
    expect(error.name).toBe('PermissionAlreadyRetiredError');
    expect(error.code).toBe('GOVERNANCE_PERMISSION_ALREADY_RETIRED');
    expect(error.metadata).toEqual({ identity: 'job_listing:view', id: 'p-1' });
  });
});

describe.each([
  ['GovernanceValidationError', GovernanceValidationError, 'GOVERNANCE_VALIDATION_ERROR'],
  ['GovernanceConflictError', GovernanceConflictError, 'GOVERNANCE_CONFLICT_ERROR'],
])('%s', (name, ErrorClass, expectedCode) => {
  it(`is a PermissionGovernanceError with code ${expectedCode}`, () => {
    const error = new ErrorClass('something went wrong', { extra: true });
    expect(error).toBeInstanceOf(PermissionGovernanceError);
    expect(error).toBeInstanceOf(ErrorClass);
    expect(error.name).toBe(name);
    expect(error.code).toBe(expectedCode);
    expect(error.metadata).toEqual({ extra: true });
  });

  it('prefixes the message with [Governance]', () => {
    expect(new ErrorClass('something went wrong').message).toBe('[Governance] something went wrong');
  });

  it('defaults metadata to an empty object', () => {
    expect(new ErrorClass('no metadata').metadata).toEqual({});
  });
});
