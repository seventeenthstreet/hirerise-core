'use strict';

/**
 * @file repository/__tests__/snapshot.repository.errors.test.js
 * KR-02B-01 — Snapshot Repository Foundation — error hierarchy tests
 */

const errors = require('../errors/snapshot.repository.errors');

const {
  SnapshotRepositoryError,
  SnapshotNotFoundError,
  SnapshotConflictError,
  SnapshotRepositoryValidationError,
  SnapshotDuplicateError,
  SnapshotRepositoryContractViolationError,
  SnapshotOperationNotSupportedError,
} = errors;

const SUBCLASSES = [
  ['SnapshotNotFoundError', SnapshotNotFoundError, 'SNAPSHOT_NOT_FOUND'],
  ['SnapshotConflictError', SnapshotConflictError, 'SNAPSHOT_CONFLICT'],
  ['SnapshotRepositoryValidationError', SnapshotRepositoryValidationError, 'SNAPSHOT_REPOSITORY_VALIDATION_ERROR'],
  ['SnapshotDuplicateError', SnapshotDuplicateError, 'SNAPSHOT_DUPLICATE'],
  ['SnapshotRepositoryContractViolationError', SnapshotRepositoryContractViolationError, 'SNAPSHOT_REPOSITORY_CONTRACT_VIOLATION'],
  ['SnapshotOperationNotSupportedError', SnapshotOperationNotSupportedError, 'SNAPSHOT_OPERATION_NOT_SUPPORTED'],
];

describe('SnapshotRepositoryError hierarchy', () => {
  it('every named subclass extends SnapshotRepositoryError and Error', () => {
    SUBCLASSES.forEach(([, ErrorClass]) => {
      const instance = new ErrorClass('message');
      expect(instance).toBeInstanceOf(SnapshotRepositoryError);
      expect(instance).toBeInstanceOf(Error);
    });
  });

  it('every named subclass sets the correct name and machine-readable code', () => {
    SUBCLASSES.forEach(([name, ErrorClass, code]) => {
      const instance = new ErrorClass('message');
      expect(instance.name).toBe(name);
      expect(instance.code).toBe(code);
    });
  });

  it('every named subclass carries metadata through to the instance', () => {
    SUBCLASSES.forEach(([, ErrorClass]) => {
      const instance = new ErrorClass('message', { foo: 'bar' });
      expect(instance.metadata).toEqual({ foo: 'bar' });
    });
  });

  it('defaults metadata to an empty object when omitted', () => {
    const instance = new SnapshotNotFoundError('message');
    expect(instance.metadata).toEqual({});
  });

  it('is a standalone hierarchy, not coupled to the domain error hierarchy', () => {
    // eslint-disable-next-line global-require
    const { SnapshotDomainError } = require('../../domain/errors/snapshot.errors');
    const instance = new SnapshotNotFoundError('message');
    expect(instance).not.toBeInstanceOf(SnapshotDomainError);
  });
});
