'use strict';

/**
 * @file src/domain/permission/registry/__tests__/permission.registry.ownership.test.js
 *
 * WP-ADMIN-04F-03 — Enterprise Permission Registry
 */

const { RESOURCES, VALID_RESOURCES } = require('../../permission.constants');
const { CAPABILITY_OWNERSHIP, CAPABILITY_DOMAINS, resolveCapabilityOwner } = require('../permission.registry.ownership');

describe('CAPABILITY_OWNERSHIP', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(CAPABILITY_OWNERSHIP)).toBe(true);
  });

  it('has an entry for every valid Resource', () => {
    for (const resource of VALID_RESOURCES) {
      expect(CAPABILITY_OWNERSHIP[resource]).toEqual(expect.any(String));
    }
  });

  it.each([
    [RESOURCES.USER, 'Administration'],
    [RESOURCES.ADMINISTRATION, 'Administration'],
    [RESOURCES.CMS_ENTRY, 'CMS'],
    [RESOURCES.JOB_LISTING, 'Jobs'],
    [RESOURCES.SKILL, 'Skills'],
    [RESOURCES.AI_FEATURE, 'AI Services'],
    [RESOURCES.RESUME, 'Resume Intelligence'],
    [RESOURCES.SNAPSHOT, 'Snapshot Intelligence'],
  ])('%s is owned by %s', (resource, expectedOwner) => {
    expect(CAPABILITY_OWNERSHIP[resource]).toBe(expectedOwner);
  });
});

describe('CAPABILITY_DOMAINS', () => {
  it('is frozen and de-duplicated', () => {
    expect(Object.isFrozen(CAPABILITY_DOMAINS)).toBe(true);
    expect(new Set(CAPABILITY_DOMAINS).size).toBe(CAPABILITY_DOMAINS.length);
  });

  it('contains every distinct owner referenced by CAPABILITY_OWNERSHIP', () => {
    const expected = new Set(Object.values(CAPABILITY_OWNERSHIP));
    expect(new Set(CAPABILITY_DOMAINS)).toEqual(expected);
  });
});

describe('resolveCapabilityOwner', () => {
  it('resolves the owning domain for a known Resource', () => {
    expect(resolveCapabilityOwner(RESOURCES.SKILL)).toBe('Skills');
  });

  it('returns null for an unrecognized Resource', () => {
    expect(resolveCapabilityOwner('not-a-real-resource')).toBeNull();
  });

  it('returns null for undefined/null input', () => {
    expect(resolveCapabilityOwner(undefined)).toBeNull();
    expect(resolveCapabilityOwner(null)).toBeNull();
  });
});
