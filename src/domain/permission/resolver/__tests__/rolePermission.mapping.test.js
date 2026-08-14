'use strict';

const { ROLE_PERMISSION_MAP } = require('../rolePermission.mapping');
const { ROLES, VALID_ROLES } = require('../roles.constants');
const { INITIAL_PERMISSION_CATALOG } = require('../../permission.catalog');

const EXPECTED_CATALOG_PAIRS = INITIAL_PERMISSION_CATALOG.map(({ resource, action }) => ({ resource, action }));

describe('ROLE_PERMISSION_MAP', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(ROLE_PERMISSION_MAP)).toBe(true);
  });

  it('has an entry for every known Role', () => {
    expect(Object.keys(ROLE_PERMISSION_MAP).sort()).toEqual([...VALID_ROLES].sort());
  });

  it('leaves USER and CONTRIBUTOR mapped to an empty, frozen grant list — no invented scope for either role', () => {
    for (const role of [ROLES.USER, ROLES.CONTRIBUTOR]) {
      expect(ROLE_PERMISSION_MAP[role]).toEqual([]);
      expect(Object.isFrozen(ROLE_PERMISSION_MAP[role])).toBe(true);
    }
  });

  it('grants ADMIN and SUPER_ADMIN exactly the Initial Enterprise Permission Catalog (WP-ADMIN-04F-11/-12A)', () => {
    for (const role of [ROLES.ADMIN, ROLES.SUPER_ADMIN]) {
      expect(Object.isFrozen(ROLE_PERMISSION_MAP[role])).toBe(true);
      expect(ROLE_PERMISSION_MAP[role]).toEqual(EXPECTED_CATALOG_PAIRS);
    }
  });

  it('every ADMIN/SUPER_ADMIN grant entry is itself frozen', () => {
    for (const role of [ROLES.ADMIN, ROLES.SUPER_ADMIN]) {
      for (const pair of ROLE_PERMISSION_MAP[role]) {
        expect(Object.isFrozen(pair)).toBe(true);
      }
    }
  });
});
