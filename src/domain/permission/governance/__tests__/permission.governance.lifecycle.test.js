'use strict';

/**
 * @file src/domain/permission/governance/__tests__/permission.governance.lifecycle.test.js
 *
 * WP-ADMIN-04F-04 — Enterprise Permission Governance Services
 */

const { PERMISSION_STATUS } = require('../../permission.constants');
const {
  isValidLifecycleTransition,
  getNextLifecycleStatus,
  isTerminalLifecycleStatus,
} = require('../permission.governance.lifecycle');

const {
  PROPOSED, APPROVED, PUBLISHED, ADOPTED, DEPRECATED, RETIRED,
} = PERMISSION_STATUS;

describe('isValidLifecycleTransition', () => {
  it.each([
    [PROPOSED, APPROVED],
    [APPROVED, PUBLISHED],
    [PUBLISHED, ADOPTED],
    [ADOPTED, DEPRECATED],
    [DEPRECATED, RETIRED],
  ])('accepts the forward transition %s -> %s', (from, to) => {
    expect(isValidLifecycleTransition(from, to)).toBe(true);
  });

  it.each([
    [RETIRED, PUBLISHED],
    [ADOPTED, PROPOSED],
    [DEPRECATED, APPROVED],
  ])('rejects the backward transition %s -> %s', (from, to) => {
    expect(isValidLifecycleTransition(from, to)).toBe(false);
  });

  it('rejects skipping a stage', () => {
    expect(isValidLifecycleTransition(PROPOSED, PUBLISHED)).toBe(false);
    expect(isValidLifecycleTransition(APPROVED, ADOPTED)).toBe(false);
  });

  it('rejects any transition out of the terminal Retired stage', () => {
    expect(isValidLifecycleTransition(RETIRED, RETIRED)).toBe(false);
  });

  it('rejects a duplicate (no-op) transition', () => {
    expect(isValidLifecycleTransition(PROPOSED, PROPOSED)).toBe(false);
  });

  it('rejects unrecognized statuses on either side', () => {
    expect(isValidLifecycleTransition('not-a-status', APPROVED)).toBe(false);
    expect(isValidLifecycleTransition(PROPOSED, 'not-a-status')).toBe(false);
  });
});

describe('getNextLifecycleStatus', () => {
  it('returns the single next stage for each non-terminal status', () => {
    expect(getNextLifecycleStatus(PROPOSED)).toBe(APPROVED);
    expect(getNextLifecycleStatus(APPROVED)).toBe(PUBLISHED);
    expect(getNextLifecycleStatus(PUBLISHED)).toBe(ADOPTED);
    expect(getNextLifecycleStatus(ADOPTED)).toBe(DEPRECATED);
    expect(getNextLifecycleStatus(DEPRECATED)).toBe(RETIRED);
  });

  it('returns null for the terminal Retired stage', () => {
    expect(getNextLifecycleStatus(RETIRED)).toBeNull();
  });

  it('returns null for an unrecognized status', () => {
    expect(getNextLifecycleStatus('not-a-status')).toBeNull();
  });
});

describe('isTerminalLifecycleStatus', () => {
  it('is true only for Retired', () => {
    expect(isTerminalLifecycleStatus(RETIRED)).toBe(true);
    expect(isTerminalLifecycleStatus(DEPRECATED)).toBe(false);
    expect(isTerminalLifecycleStatus(PROPOSED)).toBe(false);
  });
});
