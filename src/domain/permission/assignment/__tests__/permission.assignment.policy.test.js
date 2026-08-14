'use strict';

/**
 * @file src/domain/permission/assignment/__tests__/permission.assignment.policy.test.js
 *
 * WP-ADMIN-04F-06 — Enterprise Permission Assignment Services
 */

const { PERMISSION_STATUS } = require('../../permission.constants');
const { DefaultAssignmentPolicy, defaultAssignmentPolicy } = require('../permission.assignment.policy');

const { PROPOSED, APPROVED, PUBLISHED, ADOPTED, DEPRECATED, RETIRED } = PERMISSION_STATUS;

describe('DefaultAssignmentPolicy.isAssignable', () => {
  test.each([PUBLISHED, ADOPTED])('reports "%s" as assignable', (status) => {
    expect(new DefaultAssignmentPolicy().isAssignable(status)).toBe(true);
  });

  test.each([PROPOSED, APPROVED, DEPRECATED, RETIRED])('reports "%s" as not assignable', (status) => {
    expect(new DefaultAssignmentPolicy().isAssignable(status)).toBe(false);
  });
});

describe('defaultAssignmentPolicy singleton', () => {
  test('is an instance of DefaultAssignmentPolicy', () => {
    expect(defaultAssignmentPolicy).toBeInstanceOf(DefaultAssignmentPolicy);
  });
});
