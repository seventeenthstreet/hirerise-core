'use strict';

/**
 * @file src/domain/permission/evaluation/__tests__/permission.evaluation.errors.test.js
 *
 * WP-ADMIN-04F-05 — Authorization Evaluation Engine
 */

const {
  AuthorizationEvaluationError,
  PermissionNotFoundError,
  PermissionNotEvaluableError,
  AuthorizationContextError,
  UnsupportedEvaluationError,
} = require('../permission.evaluation.errors');

describe('permission.evaluation.errors', () => {
  test('AuthorizationEvaluationError carries name, code and metadata', () => {
    const err = new AuthorizationEvaluationError('boom', 'SOME_CODE', { foo: 'bar' });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AuthorizationEvaluationError');
    expect(err.code).toBe('SOME_CODE');
    expect(err.metadata).toEqual({ foo: 'bar' });
  });

  test('PermissionNotFoundError extends AuthorizationEvaluationError and carries identity', () => {
    const err = new PermissionNotFoundError('job_listing:view');
    expect(err).toBeInstanceOf(AuthorizationEvaluationError);
    expect(err.name).toBe('PermissionNotFoundError');
    expect(err.code).toBe('EVALUATION_PERMISSION_NOT_FOUND');
    expect(err.metadata.identity).toBe('job_listing:view');
    expect(err.message).toContain('job_listing:view');
  });

  test('PermissionNotEvaluableError carries identity and status', () => {
    const err = new PermissionNotEvaluableError('job_listing:view', 'proposed');
    expect(err).toBeInstanceOf(AuthorizationEvaluationError);
    expect(err.name).toBe('PermissionNotEvaluableError');
    expect(err.code).toBe('EVALUATION_PERMISSION_NOT_EVALUABLE');
    expect(err.metadata).toMatchObject({ identity: 'job_listing:view', status: 'proposed' });
  });

  test('AuthorizationContextError extends AuthorizationEvaluationError', () => {
    const err = new AuthorizationContextError('missing userId');
    expect(err).toBeInstanceOf(AuthorizationEvaluationError);
    expect(err.name).toBe('AuthorizationContextError');
    expect(err.code).toBe('EVALUATION_CONTEXT_ERROR');
    expect(err.message).toContain('missing userId');
  });

  test('UnsupportedEvaluationError extends AuthorizationEvaluationError', () => {
    const err = new UnsupportedEvaluationError('not an object');
    expect(err).toBeInstanceOf(AuthorizationEvaluationError);
    expect(err.name).toBe('UnsupportedEvaluationError');
    expect(err.code).toBe('EVALUATION_UNSUPPORTED_REQUEST');
  });
});
