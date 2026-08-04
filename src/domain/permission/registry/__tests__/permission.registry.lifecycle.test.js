'use strict';

/**
 * @file src/domain/permission/registry/__tests__/permission.registry.lifecycle.test.js
 *
 * WP-ADMIN-04F-03 — Enterprise Permission Registry
 */

const { PERMISSION_STATUS, VALID_PERMISSION_STATUSES } = require('../../permission.constants');
const { LIFECYCLE_STAGE_ORDER, describeLifecycleStage, listLifecycleStages } = require('../permission.registry.lifecycle');

describe('LIFECYCLE_STAGE_ORDER', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(LIFECYCLE_STAGE_ORDER)).toBe(true);
  });

  it('matches every valid PERMISSION_STATUS value, in the same order', () => {
    expect([...LIFECYCLE_STAGE_ORDER]).toEqual([...VALID_PERMISSION_STATUSES]);
  });
});

describe('describeLifecycleStage', () => {
  it('describes PROPOSED as stage 0, non-terminal', () => {
    const stage = describeLifecycleStage(PERMISSION_STATUS.PROPOSED);
    expect(stage).toEqual({ status: 'proposed', label: 'Proposed', stageIndex: 0, isTerminal: false });
  });

  it('describes RETIRED as the final, terminal stage', () => {
    const stage = describeLifecycleStage(PERMISSION_STATUS.RETIRED);
    expect(stage.isTerminal).toBe(true);
    expect(stage.stageIndex).toBe(LIFECYCLE_STAGE_ORDER.length - 1);
  });

  it('describes DEPRECATED as non-terminal (precursor to Retirement, AUTH-04 §2)', () => {
    const stage = describeLifecycleStage(PERMISSION_STATUS.DEPRECATED);
    expect(stage.isTerminal).toBe(false);
  });

  it('returns a frozen object', () => {
    expect(Object.isFrozen(describeLifecycleStage(PERMISSION_STATUS.APPROVED))).toBe(true);
  });

  it('returns null for an unrecognized status', () => {
    expect(describeLifecycleStage('not-a-status')).toBeNull();
  });

  it.each(VALID_PERMISSION_STATUSES)('assigns a strictly increasing stageIndex for %s', (status) => {
    const stage = describeLifecycleStage(status);
    expect(stage.stageIndex).toBe(LIFECYCLE_STAGE_ORDER.indexOf(status));
  });
});

describe('listLifecycleStages', () => {
  it('returns every stage in governance order', () => {
    const stages = listLifecycleStages();
    expect(stages.map((s) => s.status)).toEqual([...LIFECYCLE_STAGE_ORDER]);
  });

  it('returns exactly one entry per valid status', () => {
    expect(listLifecycleStages()).toHaveLength(VALID_PERMISSION_STATUSES.length);
  });
});
