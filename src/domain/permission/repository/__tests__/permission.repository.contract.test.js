'use strict';

/**
 * @file src/domain/permission/repository/__tests__/permission.repository.contract.test.js
 *
 * WP-ADMIN-04F-02 — Permission Repository
 */

const {
  PermissionRepository,
  assertPermissionRepositoryContractCompliance,
} = require('../permission.repository.contract');
const { PermissionRepositoryError } = require('../permission.repository.errors');

const CONTRACT_METHODS = [
  'create',
  'findById',
  'findByName',
  'update',
  'delete',
  'existsById',
  'existsByName',
  'findByResource',
  'findByAction',
  'findByCategory',
  'findByStatus',
  'list',
  'search',
];

describe('PermissionRepository (abstract base)', () => {
  it.each(CONTRACT_METHODS)('%s() throws "not implemented" on the base class', async (method) => {
    const repo = new PermissionRepository();
    await expect(repo[method]()).rejects.toThrow(PermissionRepositoryError);
    await expect(repo[method]()).rejects.toThrow(/is not implemented/);
  });
});

describe('assertPermissionRepositoryContractCompliance', () => {
  it('passes for an object implementing every required method', () => {
    const candidate = Object.fromEntries(CONTRACT_METHODS.map((m) => [m, async () => {}]));
    expect(() => assertPermissionRepositoryContractCompliance(candidate)).not.toThrow();
  });

  it('passes for the abstract base class itself (methods exist, even if unimplemented)', () => {
    expect(() => assertPermissionRepositoryContractCompliance(new PermissionRepository())).not.toThrow();
  });

  it('throws PermissionRepositoryError listing every missing method', () => {
    const candidate = { create: async () => {}, findById: async () => {} };

    try {
      assertPermissionRepositoryContractCompliance(candidate);
      throw new Error('expected assertPermissionRepositoryContractCompliance to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(PermissionRepositoryError);
      expect(error.metadata.missing).toEqual(expect.arrayContaining(['update', 'delete', 'search']));
      expect(error.metadata.missing).not.toContain('create');
      expect(error.metadata.missing).not.toContain('findById');
    }
  });

  it('throws for a null candidate', () => {
    expect(() => assertPermissionRepositoryContractCompliance(null)).toThrow(PermissionRepositoryError);
  });

  it('throws for an empty object', () => {
    expect(() => assertPermissionRepositoryContractCompliance({})).toThrow(PermissionRepositoryError);
  });
});
