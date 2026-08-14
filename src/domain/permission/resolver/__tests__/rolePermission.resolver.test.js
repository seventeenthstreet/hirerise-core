'use strict';

const { RESOURCES, ACTIONS } = require('../../permission.constants');
const { buildPermissionName } = require('../../permission.model');
const { RolePermissionResolver, rolePermissionResolver } = require('../rolePermission.resolver');
const { InvalidRoleError } = require('../rolePermission.errors');
const { ROLE_PERMISSION_MAP } = require('../rolePermission.mapping');
const { ROLES } = require('../roles.constants');

const RESOURCE_A = RESOURCES.JOB_LISTING;
const ACTION_A = ACTIONS.VIEW;
const RESOURCE_B = RESOURCES.SKILL;
const ACTION_B = ACTIONS.CREATE;

describe('RolePermissionResolver — role resolution', () => {
  it('resolves a mapped role to the frozen array of Permission identities the mapping declares', () => {
    const mapping = {
      [ROLES.ADMIN]: [
        { resource: RESOURCE_A, action: ACTION_A },
        { resource: RESOURCE_B, action: ACTION_B },
      ],
    };
    const resolver = new RolePermissionResolver(mapping);

    const result = resolver.resolve(ROLES.ADMIN);

    expect(result).toEqual([
      buildPermissionName(RESOURCE_A, ACTION_A),
      buildPermissionName(RESOURCE_B, ACTION_B),
    ]);
  });

  it('resolves a role with no entries to an empty array', () => {
    const resolver = new RolePermissionResolver({ [ROLES.USER]: [] });
    expect(resolver.resolve(ROLES.USER)).toEqual([]);
  });

  it('resolves an unknown role to an empty array rather than throwing (backward compatibility)', () => {
    const resolver = new RolePermissionResolver({ [ROLES.ADMIN]: [{ resource: RESOURCE_A, action: ACTION_A }] });
    expect(resolver.resolve('not-a-known-role')).toEqual([]);
  });

  it('throws InvalidRoleError for a non-string role', () => {
    const resolver = new RolePermissionResolver();
    expect(() => resolver.resolve(null)).toThrow(InvalidRoleError);
    expect(() => resolver.resolve(undefined)).toThrow(InvalidRoleError);
    expect(() => resolver.resolve(42)).toThrow(InvalidRoleError);
    expect(() => resolver.resolve({})).toThrow(InvalidRoleError);
  });

  it('throws InvalidRoleError for an empty string role', () => {
    const resolver = new RolePermissionResolver();
    expect(() => resolver.resolve('')).toThrow(InvalidRoleError);
  });
});

describe('RolePermissionResolver — immutability', () => {
  it('returns a frozen array', () => {
    const resolver = new RolePermissionResolver({ [ROLES.ADMIN]: [{ resource: RESOURCE_A, action: ACTION_A }] });
    const result = resolver.resolve(ROLES.ADMIN);
    expect(Object.isFrozen(result)).toBe(true);
    expect(() => {
      result.push('should-not-be-allowed');
    }).toThrow();
  });

  it('returns the same frozen array reference on repeated calls (immutable cache, no request-scoped mutation)', () => {
    const resolver = new RolePermissionResolver({ [ROLES.ADMIN]: [{ resource: RESOURCE_A, action: ACTION_A }] });
    const first = resolver.resolve(ROLES.ADMIN);
    const second = resolver.resolve(ROLES.ADMIN);
    expect(first).toBe(second);
  });

  it('is unaffected by later mutation of the constructor-provided mapping object', () => {
    const mapping = { [ROLES.ADMIN]: [{ resource: RESOURCE_A, action: ACTION_A }] };
    const resolver = new RolePermissionResolver(mapping);
    const before = resolver.resolve(ROLES.ADMIN);

    mapping[ROLES.ADMIN].push({ resource: RESOURCE_B, action: ACTION_B });

    expect(resolver.resolve(ROLES.ADMIN)).toEqual(before);
  });
});

describe('RolePermissionResolver — duplicate permissions', () => {
  it('does not deduplicate a role mapped to the same pair twice — the mapping is the single source of truth', () => {
    const resolver = new RolePermissionResolver({
      [ROLES.ADMIN]: [
        { resource: RESOURCE_A, action: ACTION_A },
        { resource: RESOURCE_A, action: ACTION_A },
      ],
    });
    expect(resolver.resolve(ROLES.ADMIN)).toEqual([
      buildPermissionName(RESOURCE_A, ACTION_A),
      buildPermissionName(RESOURCE_A, ACTION_A),
    ]);
  });
});

describe('rolePermissionResolver (default singleton)', () => {
  it('is constructed from the centralized ROLE_PERMISSION_MAP', () => {
    for (const role of Object.keys(ROLE_PERMISSION_MAP)) {
      expect(rolePermissionResolver.resolve(role)).toEqual(
        ROLE_PERMISSION_MAP[role].map((pair) => buildPermissionName(pair.resource, pair.action)),
      );
    }
  });
});
