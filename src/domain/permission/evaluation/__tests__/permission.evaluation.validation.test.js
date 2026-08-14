'use strict';

/**
 * @file src/domain/permission/evaluation/__tests__/permission.evaluation.validation.test.js
 *
 * WP-ADMIN-04F-05 — Authorization Evaluation Engine
 */

const { validateEvaluationRequestShape, validateNoDuplicateRequests } = require('../permission.evaluation.validation');
const { UnsupportedEvaluationError, AuthorizationContextError } = require('../permission.evaluation.errors');

function makeRequest(overrides = {}) {
  return {
    userId: 'u-1',
    resource: 'job_listing',
    action: 'view',
    ...overrides,
  };
}

describe('validateEvaluationRequestShape', () => {
  test('accepts a well-formed request', () => {
    expect(() => validateEvaluationRequestShape(makeRequest())).not.toThrow();
  });

  test.each([null, undefined, 'string', 42, []])('rejects non-object request: %p', (value) => {
    expect(() => validateEvaluationRequestShape(value)).toThrow(UnsupportedEvaluationError);
  });

  test('rejects missing userId', () => {
    expect(() => validateEvaluationRequestShape(makeRequest({ userId: undefined }))).toThrow(AuthorizationContextError);
  });

  test('rejects empty-string resource', () => {
    expect(() => validateEvaluationRequestShape(makeRequest({ resource: '' }))).toThrow(AuthorizationContextError);
  });

  test('rejects non-string action', () => {
    expect(() => validateEvaluationRequestShape(makeRequest({ action: 123 }))).toThrow(AuthorizationContextError);
  });
});

describe('validateNoDuplicateRequests', () => {
  test('accepts a batch of distinct requests', () => {
    const batch = [
      makeRequest({ userId: 'u-1' }),
      makeRequest({ userId: 'u-2' }),
      makeRequest({ resource: 'skill', action: 'update' }),
    ];
    expect(() => validateNoDuplicateRequests(batch)).not.toThrow();
  });

  test('rejects a non-array batch', () => {
    expect(() => validateNoDuplicateRequests({})).toThrow(UnsupportedEvaluationError);
  });

  test('rejects duplicate requests within a batch', () => {
    const batch = [makeRequest(), makeRequest()];
    expect(() => validateNoDuplicateRequests(batch)).toThrow(UnsupportedEvaluationError);
  });

  test('treats requests differing only by resourceId as distinct', () => {
    const batch = [makeRequest({ resourceId: 'r-1' }), makeRequest({ resourceId: 'r-2' })];
    expect(() => validateNoDuplicateRequests(batch)).not.toThrow();
  });

  test('validates each request shape before checking duplicates', () => {
    const batch = [makeRequest(), { userId: '', resource: 'job_listing', action: 'view' }];
    expect(() => validateNoDuplicateRequests(batch)).toThrow(AuthorizationContextError);
  });
});
