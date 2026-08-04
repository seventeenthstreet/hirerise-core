'use strict';

/**
 * @file src/domain/permission/registry/__tests__/permission.registry.errors.test.js
 *
 * WP-ADMIN-04F-03 — Enterprise Permission Registry
 */

const {
  PermissionRegistryError,
  PermissionRegistryValidationError,
  DuplicatePermissionIdentityError,
  MalformedRegistryEntryError,
} = require('../permission.registry.errors');

describe('PermissionRegistryError', () => {
  it('carries a message, code, and metadata', () => {
    const error = new PermissionRegistryError('boom', 'SOME_CODE', { foo: 'bar' });
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('boom');
    expect(error.code).toBe('SOME_CODE');
    expect(error.metadata).toEqual({ foo: 'bar' });
  });
});

describe.each([
  ['PermissionRegistryValidationError', PermissionRegistryValidationError, 'PERMISSION_REGISTRY_VALIDATION_ERROR'],
  ['DuplicatePermissionIdentityError', DuplicatePermissionIdentityError, 'PERMISSION_REGISTRY_DUPLICATE_IDENTITY'],
  ['MalformedRegistryEntryError', MalformedRegistryEntryError, 'PERMISSION_REGISTRY_MALFORMED_ENTRY'],
])('%s', (name, ErrorClass, expectedCode) => {
  it(`is a PermissionRegistryError with code ${expectedCode}`, () => {
    const error = new ErrorClass('something went wrong', { extra: true });
    expect(error).toBeInstanceOf(PermissionRegistryError);
    expect(error).toBeInstanceOf(ErrorClass);
    expect(error.name).toBe(name);
    expect(error.code).toBe(expectedCode);
    expect(error.metadata).toEqual({ extra: true });
  });

  it('defaults metadata to an empty object', () => {
    expect(new ErrorClass('no metadata').metadata).toEqual({});
  });
});
