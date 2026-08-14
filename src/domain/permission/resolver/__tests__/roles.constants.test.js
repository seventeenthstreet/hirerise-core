'use strict';

const { ROLES, VALID_ROLES } = require('../roles.constants');

describe('ROLES', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(ROLES)).toBe(true);
  });

  it('exposes the roles observed across the existing role-check call sites', () => {
    expect(ROLES).toEqual({
      USER: 'user',
      CONTRIBUTOR: 'contributor',
      ADMIN: 'admin',
      SUPER_ADMIN: 'super_admin',
    });
  });
});

describe('VALID_ROLES', () => {
  it('is a frozen array containing every ROLES value exactly once', () => {
    expect(Object.isFrozen(VALID_ROLES)).toBe(true);
    expect(new Set(VALID_ROLES).size).toBe(VALID_ROLES.length);
    expect([...VALID_ROLES].sort()).toEqual(Object.values(ROLES).sort());
  });
});
