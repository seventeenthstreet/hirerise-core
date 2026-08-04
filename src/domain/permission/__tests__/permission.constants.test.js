'use strict';

/**
 * @file src/domain/permission/__tests__/permission.constants.test.js
 *
 * WP-ADMIN-04F-01 — Permission Domain Foundation
 */

const {
  RESOURCES,
  VALID_RESOURCES,
  CORE_ACTIONS,
  ACTIONS,
  VALID_ACTIONS,
  PERMISSION_CATEGORIES,
  VALID_PERMISSION_CATEGORIES,
  PERMISSION_STATUS,
  VALID_PERMISSION_STATUSES,
  AUTHORIZATION_DECISIONS,
  VALID_AUTHORIZATION_DECISIONS,
} = require('../permission.constants');

describe('permission.constants', () => {
  it('freezes every exported constant object', () => {
    expect(Object.isFrozen(RESOURCES)).toBe(true);
    expect(Object.isFrozen(ACTIONS)).toBe(true);
    expect(Object.isFrozen(CORE_ACTIONS)).toBe(true);
    expect(Object.isFrozen(PERMISSION_CATEGORIES)).toBe(true);
    expect(Object.isFrozen(PERMISSION_STATUS)).toBe(true);
    expect(Object.isFrozen(AUTHORIZATION_DECISIONS)).toBe(true);
  });

  it('derives each VALID_* array from its corresponding enum object', () => {
    expect(VALID_RESOURCES).toEqual(Object.values(RESOURCES));
    expect(VALID_ACTIONS).toEqual(Object.values(ACTIONS));
    expect(VALID_PERMISSION_CATEGORIES).toEqual(Object.values(PERMISSION_CATEGORIES));
    expect(VALID_PERMISSION_STATUSES).toEqual(Object.values(PERMISSION_STATUS));
    expect(VALID_AUTHORIZATION_DECISIONS).toEqual(Object.values(AUTHORIZATION_DECISIONS));
  });

  it('has no duplicate values within any single enum', () => {
    [RESOURCES, ACTIONS, PERMISSION_CATEGORIES, PERMISSION_STATUS, AUTHORIZATION_DECISIONS].forEach(
      (enumObject) => {
        const values = Object.values(enumObject);
        expect(new Set(values).size).toBe(values.length);
      },
    );
  });

  it('includes every CORE_ACTIONS entry inside ACTIONS', () => {
    Object.values(CORE_ACTIONS).forEach((coreAction) => {
      expect(VALID_ACTIONS).toContain(coreAction);
    });
  });

  it('defines the core stable verb set: view, create, update, delete', () => {
    expect(Object.values(CORE_ACTIONS).sort()).toEqual(['create', 'delete', 'update', 'view']);
  });

  it('defines the AUTH-04 §6 governance-derived Permission Status set', () => {
    expect(Object.values(PERMISSION_STATUS).sort()).toEqual(
      ['adopted', 'approved', 'deprecated', 'proposed', 'published', 'retired'],
    );
  });

  it('defines exactly Allow and Deny as Authorization Decision outcomes', () => {
    expect(Object.values(AUTHORIZATION_DECISIONS).sort()).toEqual(['allow', 'deny']);
  });

  it('exposes only string primitive values across every enum', () => {
    [RESOURCES, ACTIONS, PERMISSION_CATEGORIES, PERMISSION_STATUS, AUTHORIZATION_DECISIONS].forEach(
      (enumObject) => {
        Object.values(enumObject).forEach((value) => {
          expect(typeof value).toBe('string');
          expect(value.length).toBeGreaterThan(0);
        });
      },
    );
  });
});
