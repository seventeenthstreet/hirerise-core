'use strict';

/**
 * @file src/domain/permission/__tests__/permission.validation.test.js
 *
 * WP-ADMIN-04F-01 — Permission Domain Foundation
 */

const { RESOURCES, ACTIONS, PERMISSION_CATEGORIES, PERMISSION_STATUS, AUTHORIZATION_DECISIONS } = require('../permission.constants');
const {
  isValidResource,
  isValidAction,
  isValidPermissionCategory,
  isValidPermissionStatus,
  isValidAuthorizationDecisionOutcome,
  validateResource,
  validateAction,
  validatePermissionCategory,
  validatePermissionStatus,
  validateAuthorizationDecisionOutcome,
  validatePermission,
  validateAuthorizationContext,
  validateAuthorizationDecision,
} = require('../permission.validation');
const {
  InvalidResourceError,
  InvalidActionError,
  InvalidPermissionCategoryError,
  InvalidPermissionStatusError,
  InvalidPermissionError,
  InvalidAuthorizationContextError,
  InvalidAuthorizationDecisionError,
} = require('../permission.errors');

describe('Resource validation', () => {
  it('accepts every enterprise Resource constant', () => {
    Object.values(RESOURCES).forEach((resource) => {
      expect(isValidResource(resource)).toBe(true);
      expect(validateResource(resource)).toBe(resource);
    });
  });

  it('rejects an unknown Resource string', () => {
    expect(isValidResource('not_a_resource')).toBe(false);
    expect(() => validateResource('not_a_resource')).toThrow(InvalidResourceError);
  });

  it('rejects non-string values', () => {
    [null, undefined, 42, {}, []].forEach((value) => {
      expect(isValidResource(value)).toBe(false);
      expect(() => validateResource(value)).toThrow(InvalidResourceError);
    });
  });
});

describe('Action validation', () => {
  it('accepts every enterprise Action constant', () => {
    Object.values(ACTIONS).forEach((action) => {
      expect(isValidAction(action)).toBe(true);
      expect(validateAction(action)).toBe(action);
    });
  });

  it('rejects an unknown Action string', () => {
    expect(isValidAction('teleport')).toBe(false);
    expect(() => validateAction('teleport')).toThrow(InvalidActionError);
  });
});

describe('Permission Category validation', () => {
  it('accepts every enterprise Permission Category constant', () => {
    Object.values(PERMISSION_CATEGORIES).forEach((category) => {
      expect(isValidPermissionCategory(category)).toBe(true);
      expect(validatePermissionCategory(category)).toBe(category);
    });
  });

  it('treats null and undefined as a valid "no category" value', () => {
    expect(validatePermissionCategory(null)).toBeNull();
    expect(validatePermissionCategory(undefined)).toBeNull();
  });

  it('rejects an unknown Permission Category string', () => {
    expect(isValidPermissionCategory('marketing')).toBe(false);
    expect(() => validatePermissionCategory('marketing')).toThrow(InvalidPermissionCategoryError);
  });
});

describe('Permission Status validation', () => {
  it('accepts every enterprise Permission Status constant', () => {
    Object.values(PERMISSION_STATUS).forEach((status) => {
      expect(isValidPermissionStatus(status)).toBe(true);
      expect(validatePermissionStatus(status)).toBe(status);
    });
  });

  it('rejects an unknown Permission Status string', () => {
    expect(isValidPermissionStatus('archived')).toBe(false);
    expect(() => validatePermissionStatus('archived')).toThrow(InvalidPermissionStatusError);
  });

  it('rejects null', () => {
    expect(() => validatePermissionStatus(null)).toThrow(InvalidPermissionStatusError);
  });
});

describe('Authorization Decision outcome validation', () => {
  it('accepts Allow and Deny', () => {
    Object.values(AUTHORIZATION_DECISIONS).forEach((outcome) => {
      expect(isValidAuthorizationDecisionOutcome(outcome)).toBe(true);
      expect(validateAuthorizationDecisionOutcome(outcome)).toBe(outcome);
    });
  });

  it('rejects an unknown outcome string', () => {
    expect(isValidAuthorizationDecisionOutcome('maybe')).toBe(false);
    expect(() => validateAuthorizationDecisionOutcome('maybe')).toThrow(InvalidAuthorizationDecisionError);
  });
});

describe('validatePermission', () => {
  const validPermission = Object.freeze({
    name: 'job_listing:view',
    resource: RESOURCES.JOB_LISTING,
    action: ACTIONS.VIEW,
    category: PERMISSION_CATEGORIES.JOBS,
    status: PERMISSION_STATUS.PUBLISHED,
    description: 'View job listings',
  });

  it('accepts a well-formed Permission', () => {
    expect(validatePermission(validPermission)).toBe(validPermission);
  });

  it('accepts a Permission with a null category and description', () => {
    const permission = { ...validPermission, category: null, description: null };
    expect(validatePermission(permission)).toBe(permission);
  });

  it('rejects a non-object', () => {
    expect(() => validatePermission(null)).toThrow(InvalidPermissionError);
    expect(() => validatePermission('permission')).toThrow(InvalidPermissionError);
    expect(() => validatePermission([])).toThrow(InvalidPermissionError);
  });

  it('rejects an invalid resource', () => {
    expect(() => validatePermission({ ...validPermission, resource: 'bogus' })).toThrow(InvalidResourceError);
  });

  it('rejects an invalid action', () => {
    expect(() => validatePermission({ ...validPermission, action: 'bogus' })).toThrow(InvalidActionError);
  });

  it('rejects an invalid status', () => {
    expect(() => validatePermission({ ...validPermission, status: 'bogus' })).toThrow(InvalidPermissionStatusError);
  });

  it('rejects a name that does not match resource:action', () => {
    expect(() => validatePermission({ ...validPermission, name: 'job_listing:delete' })).toThrow(
      InvalidPermissionError,
    );
  });

  it('rejects a missing or empty name', () => {
    expect(() => validatePermission({ ...validPermission, name: '' })).toThrow(InvalidPermissionError);
    expect(() => validatePermission({ ...validPermission, name: undefined })).toThrow(InvalidPermissionError);
  });

  it('rejects a non-string description', () => {
    expect(() => validatePermission({ ...validPermission, description: 42 })).toThrow(InvalidPermissionError);
  });
});

describe('validateAuthorizationContext', () => {
  const validContext = Object.freeze({
    userId: 'user-123',
    resource: RESOURCES.CMS_ENTRY,
    action: ACTIONS.UPDATE,
    resourceId: 'cms-entry-456',
    metadata: {},
  });

  it('accepts a well-formed Authorization Context', () => {
    expect(validateAuthorizationContext(validContext)).toBe(validContext);
  });

  it('accepts a minimal context without resourceId or metadata', () => {
    const context = { userId: 'user-123', resource: RESOURCES.USER, action: ACTIONS.VIEW };
    expect(validateAuthorizationContext(context)).toBe(context);
  });

  it('rejects a non-object', () => {
    expect(() => validateAuthorizationContext(null)).toThrow(InvalidAuthorizationContextError);
    expect(() => validateAuthorizationContext([])).toThrow(InvalidAuthorizationContextError);
  });

  it('rejects a missing or empty userId', () => {
    expect(() => validateAuthorizationContext({ ...validContext, userId: '' })).toThrow(
      InvalidAuthorizationContextError,
    );
    expect(() => validateAuthorizationContext({ ...validContext, userId: undefined })).toThrow(
      InvalidAuthorizationContextError,
    );
  });

  it('rejects an invalid resource', () => {
    expect(() => validateAuthorizationContext({ ...validContext, resource: 'bogus' })).toThrow(InvalidResourceError);
  });

  it('rejects an invalid action', () => {
    expect(() => validateAuthorizationContext({ ...validContext, action: 'bogus' })).toThrow(InvalidActionError);
  });

  it('rejects a non-string, non-null resourceId', () => {
    expect(() => validateAuthorizationContext({ ...validContext, resourceId: 42 })).toThrow(
      InvalidAuthorizationContextError,
    );
  });

  it('rejects a non-object metadata', () => {
    expect(() => validateAuthorizationContext({ ...validContext, metadata: 'nope' })).toThrow(
      InvalidAuthorizationContextError,
    );
    expect(() => validateAuthorizationContext({ ...validContext, metadata: [] })).toThrow(
      InvalidAuthorizationContextError,
    );
  });
});

describe('validateAuthorizationDecision', () => {
  const validContext = Object.freeze({
    userId: 'user-123',
    resource: RESOURCES.SKILL,
    action: ACTIONS.DELETE,
  });

  const validDecision = Object.freeze({
    outcome: AUTHORIZATION_DECISIONS.DENY,
    context: validContext,
    reason: 'no matching Permission Assignment',
    decidedAt: '2026-08-04T00:00:00.000Z',
  });

  it('accepts a well-formed Authorization Decision', () => {
    expect(validateAuthorizationDecision(validDecision)).toBe(validDecision);
  });

  it('accepts a decision with a null reason', () => {
    const decision = { ...validDecision, reason: null };
    expect(validateAuthorizationDecision(decision)).toBe(decision);
  });

  it('rejects a non-object', () => {
    expect(() => validateAuthorizationDecision(null)).toThrow(InvalidAuthorizationDecisionError);
  });

  it('rejects an invalid outcome', () => {
    expect(() => validateAuthorizationDecision({ ...validDecision, outcome: 'sure' })).toThrow(
      InvalidAuthorizationDecisionError,
    );
  });

  it('rejects a malformed context', () => {
    expect(() => validateAuthorizationDecision({ ...validDecision, context: { userId: '' } })).toThrow(
      InvalidAuthorizationContextError,
    );
  });

  it('rejects a non-string, non-null reason', () => {
    expect(() => validateAuthorizationDecision({ ...validDecision, reason: 42 })).toThrow(
      InvalidAuthorizationDecisionError,
    );
  });

  it('rejects a missing or non-ISO decidedAt', () => {
    expect(() => validateAuthorizationDecision({ ...validDecision, decidedAt: undefined })).toThrow(
      InvalidAuthorizationDecisionError,
    );
    expect(() => validateAuthorizationDecision({ ...validDecision, decidedAt: 'not-a-date' })).toThrow(
      InvalidAuthorizationDecisionError,
    );
  });
});
