'use strict';

/**
 * @file src/domain/permission/__tests__/permission.model.test.js
 *
 * WP-ADMIN-04F-01 — Permission Domain Foundation
 */

const { RESOURCES, ACTIONS, PERMISSION_CATEGORIES, PERMISSION_STATUS, AUTHORIZATION_DECISIONS } = require('../permission.constants');
const { buildPermissionName, createPermission, createAuthorizationContext, createAuthorizationDecision } = require('../permission.model');
const {
  InvalidResourceError,
  InvalidActionError,
  InvalidPermissionCategoryError,
  InvalidPermissionStatusError,
  InvalidAuthorizationContextError,
  InvalidAuthorizationDecisionError,
} = require('../permission.errors');

describe('buildPermissionName', () => {
  it('joins resource and action with a colon', () => {
    expect(buildPermissionName(RESOURCES.JOB_LISTING, ACTIONS.CREATE)).toBe('job_listing:create');
  });
});

describe('createPermission', () => {
  it('creates a well-formed Permission with defaults applied', () => {
    const permission = createPermission({ resource: RESOURCES.CMS_ENTRY, action: ACTIONS.PUBLISH });

    expect(permission).toEqual({
      name: 'cms_entry:publish',
      resource: RESOURCES.CMS_ENTRY,
      action: ACTIONS.PUBLISH,
      category: null,
      status: PERMISSION_STATUS.PROPOSED,
      description: null,
    });
  });

  it('creates a Permission with an explicit category, status, and description', () => {
    const permission = createPermission({
      resource: RESOURCES.SKILL,
      action: ACTIONS.APPROVE,
      category: PERMISSION_CATEGORIES.SKILLS,
      status: PERMISSION_STATUS.PUBLISHED,
      description: 'Approve a proposed Skill',
    });

    expect(permission.name).toBe('skill:approve');
    expect(permission.category).toBe(PERMISSION_CATEGORIES.SKILLS);
    expect(permission.status).toBe(PERMISSION_STATUS.PUBLISHED);
    expect(permission.description).toBe('Approve a proposed Skill');
  });

  it('returns a frozen object', () => {
    const permission = createPermission({ resource: RESOURCES.USER, action: ACTIONS.VIEW });
    expect(Object.isFrozen(permission)).toBe(true);
  });

  it('rejects an invalid resource', () => {
    expect(() => createPermission({ resource: 'bogus', action: ACTIONS.VIEW })).toThrow(InvalidResourceError);
  });

  it('rejects an invalid action', () => {
    expect(() => createPermission({ resource: RESOURCES.USER, action: 'bogus' })).toThrow(InvalidActionError);
  });

  it('rejects an invalid category', () => {
    expect(() =>
      createPermission({ resource: RESOURCES.USER, action: ACTIONS.VIEW, category: 'bogus' }),
    ).toThrow(InvalidPermissionCategoryError);
  });

  it('rejects an invalid status', () => {
    expect(() =>
      createPermission({ resource: RESOURCES.USER, action: ACTIONS.VIEW, status: 'bogus' }),
    ).toThrow(InvalidPermissionStatusError);
  });
});

describe('createAuthorizationContext', () => {
  it('creates a well-formed Authorization Context with defaults applied', () => {
    const context = createAuthorizationContext({
      userId: 'user-1',
      resource: RESOURCES.SNAPSHOT,
      action: ACTIONS.VIEW,
    });

    expect(context).toEqual({
      userId: 'user-1',
      resource: RESOURCES.SNAPSHOT,
      action: ACTIONS.VIEW,
      resourceId: null,
      metadata: {},
    });
  });

  it('preserves an explicit resourceId and metadata', () => {
    const context = createAuthorizationContext({
      userId: 'user-1',
      resource: RESOURCES.AI_FEATURE,
      action: ACTIONS.UPDATE,
      resourceId: 'feature-42',
      metadata: { source: 'test' },
    });

    expect(context.resourceId).toBe('feature-42');
    expect(context.metadata).toEqual({ source: 'test' });
  });

  it('returns a frozen object with frozen metadata', () => {
    const context = createAuthorizationContext({ userId: 'u', resource: RESOURCES.USER, action: ACTIONS.VIEW });
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.metadata)).toBe(true);
  });

  it('rejects a missing userId', () => {
    expect(() => createAuthorizationContext({ resource: RESOURCES.USER, action: ACTIONS.VIEW })).toThrow(
      InvalidAuthorizationContextError,
    );
  });

  it('rejects an invalid resource', () => {
    expect(() => createAuthorizationContext({ userId: 'u', resource: 'bogus', action: ACTIONS.VIEW })).toThrow(
      InvalidResourceError,
    );
  });

  it('rejects an invalid action', () => {
    expect(() => createAuthorizationContext({ userId: 'u', resource: RESOURCES.USER, action: 'bogus' })).toThrow(
      InvalidActionError,
    );
  });
});

describe('createAuthorizationDecision', () => {
  const context = createAuthorizationContext({
    userId: 'user-1',
    resource: RESOURCES.JOB_LISTING,
    action: ACTIONS.DELETE,
  });

  it('creates a well-formed Allow decision', () => {
    const decision = createAuthorizationDecision({
      outcome: AUTHORIZATION_DECISIONS.ALLOW,
      context,
      reason: 'granted via Role default',
      decidedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(decision.outcome).toBe(AUTHORIZATION_DECISIONS.ALLOW);
    expect(decision.context).toBe(context);
    expect(decision.reason).toBe('granted via Role default');
    expect(decision.decidedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('creates a well-formed Deny decision with default decidedAt and reason', () => {
    const decision = createAuthorizationDecision({ outcome: AUTHORIZATION_DECISIONS.DENY, context });

    expect(decision.outcome).toBe(AUTHORIZATION_DECISIONS.DENY);
    expect(decision.reason).toBeNull();
    expect(typeof decision.decidedAt).toBe('string');
    expect(Number.isNaN(Date.parse(decision.decidedAt))).toBe(false);
  });

  it('returns a frozen object', () => {
    const decision = createAuthorizationDecision({ outcome: AUTHORIZATION_DECISIONS.DENY, context });
    expect(Object.isFrozen(decision)).toBe(true);
  });

  it('rejects an invalid outcome', () => {
    expect(() => createAuthorizationDecision({ outcome: 'sure', context })).toThrow(
      InvalidAuthorizationDecisionError,
    );
  });

  it('rejects a malformed context', () => {
    expect(() => createAuthorizationDecision({ outcome: AUTHORIZATION_DECISIONS.ALLOW, context: {} })).toThrow(
      InvalidAuthorizationContextError,
    );
  });
});
