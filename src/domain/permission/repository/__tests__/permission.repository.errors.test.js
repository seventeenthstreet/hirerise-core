'use strict';

/**
 * @file src/domain/permission/repository/__tests__/permission.repository.errors.test.js
 *
 * WP-ADMIN-04F-02 — Permission Repository
 */

const {
  PermissionRepositoryError,
  PermissionNotFoundError,
  PermissionDuplicateError,
  PermissionRepositoryValidationError,
  PermissionMappingError,
  PermissionRepositoryContractViolationError,
} = require('../permission.repository.errors');

describe('PermissionRepositoryError', () => {
  it('carries a message, code, and metadata', () => {
    const error = new PermissionRepositoryError('boom', 'SOME_CODE', { foo: 'bar' });
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('boom');
    expect(error.code).toBe('SOME_CODE');
    expect(error.metadata).toEqual({ foo: 'bar' });
    expect(error.name).toBe('PermissionRepositoryError');
  });
});

describe.each([
  ['PermissionNotFoundError', PermissionNotFoundError, 'PERMISSION_NOT_FOUND'],
  ['PermissionDuplicateError', PermissionDuplicateError, 'PERMISSION_DUPLICATE'],
  ['PermissionRepositoryValidationError', PermissionRepositoryValidationError, 'PERMISSION_REPOSITORY_VALIDATION_ERROR'],
  ['PermissionMappingError', PermissionMappingError, 'PERMISSION_MAPPING_ERROR'],
  ['PermissionRepositoryContractViolationError', PermissionRepositoryContractViolationError, 'PERMISSION_REPOSITORY_CONTRACT_VIOLATION'],
])('%s', (name, ErrorClass, expectedCode) => {
  it(`is a PermissionRepositoryError with code ${expectedCode}`, () => {
    const error = new ErrorClass('something went wrong', { extra: true });
    expect(error).toBeInstanceOf(PermissionRepositoryError);
    expect(error).toBeInstanceOf(ErrorClass);
    expect(error.name).toBe(name);
    expect(error.code).toBe(expectedCode);
    expect(error.metadata).toEqual({ extra: true });
    expect(error.message).toBe('something went wrong');
  });

  it('defaults metadata to an empty object', () => {
    const error = new ErrorClass('no metadata');
    expect(error.metadata).toEqual({});
  });
});
