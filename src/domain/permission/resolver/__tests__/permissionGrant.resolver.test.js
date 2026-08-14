'use strict';

const { RESOURCES, ACTIONS } = require('../../permission.constants');
const { buildPermissionName } = require('../../permission.model');
const { PermissionGrantResolver } = require('../permissionGrant.resolver');
const { InvalidGrantRequestError } = require('../permissionGrant.errors');
const { ROLES } = require('../roles.constants');

const RESOURCE = RESOURCES.JOB_LISTING;
const ACTION = ACTIONS.VIEW;
const PRINCIPAL_ID = 'user-1';

function makeFakeAssignmentService({ hasAssignment = false } = {}) {
  return {
    hasAssignment: jest.fn().mockResolvedValue(hasAssignment),
  };
}

function makeFakeRoleResolver({ identities = [] } = {}) {
  return {
    resolve: jest.fn().mockReturnValue(identities),
  };
}

describe('PermissionGrantResolver — composition', () => {
  it('grants when an explicit Assignment exists, without consulting the Role resolver', async () => {
    const assignmentService = makeFakeAssignmentService({ hasAssignment: true });
    const roleResolver = makeFakeRoleResolver();
    const grantResolver = new PermissionGrantResolver(assignmentService, roleResolver);

    const result = await grantResolver.hasGrant({ principalId: PRINCIPAL_ID, role: ROLES.USER, resource: RESOURCE, action: ACTION });

    expect(result).toBe(true);
    expect(roleResolver.resolve).not.toHaveBeenCalled();
  });

  it('grants when no explicit Assignment exists but the Role derives the Permission', async () => {
    const assignmentService = makeFakeAssignmentService({ hasAssignment: false });
    const roleResolver = makeFakeRoleResolver({ identities: [buildPermissionName(RESOURCE, ACTION)] });
    const grantResolver = new PermissionGrantResolver(assignmentService, roleResolver);

    const result = await grantResolver.hasGrant({ principalId: PRINCIPAL_ID, role: ROLES.ADMIN, resource: RESOURCE, action: ACTION });

    expect(result).toBe(true);
    expect(roleResolver.resolve).toHaveBeenCalledWith(ROLES.ADMIN);
  });

  it('grants when both an explicit Assignment and a Role-derived Permission exist', async () => {
    const assignmentService = makeFakeAssignmentService({ hasAssignment: true });
    const roleResolver = makeFakeRoleResolver({ identities: [buildPermissionName(RESOURCE, ACTION)] });
    const grantResolver = new PermissionGrantResolver(assignmentService, roleResolver);

    const result = await grantResolver.hasGrant({ principalId: PRINCIPAL_ID, role: ROLES.ADMIN, resource: RESOURCE, action: ACTION });

    expect(result).toBe(true);
  });

  it('denies when neither an explicit Assignment nor a Role-derived Permission exists', async () => {
    const assignmentService = makeFakeAssignmentService({ hasAssignment: false });
    const roleResolver = makeFakeRoleResolver({ identities: [] });
    const grantResolver = new PermissionGrantResolver(assignmentService, roleResolver);

    const result = await grantResolver.hasGrant({ principalId: PRINCIPAL_ID, role: ROLES.USER, resource: RESOURCE, action: ACTION });

    expect(result).toBe(false);
  });

  it('denies and skips Role resolution when role is omitted and no explicit Assignment exists', async () => {
    const assignmentService = makeFakeAssignmentService({ hasAssignment: false });
    const roleResolver = makeFakeRoleResolver();
    const grantResolver = new PermissionGrantResolver(assignmentService, roleResolver);

    const result = await grantResolver.hasGrant({ principalId: PRINCIPAL_ID, resource: RESOURCE, action: ACTION });

    expect(result).toBe(false);
    expect(roleResolver.resolve).not.toHaveBeenCalled();
  });

  it('passes the explicit-assignment lookup exactly the {principalId, resource, action} shape the Assignment Service expects', async () => {
    const assignmentService = makeFakeAssignmentService({ hasAssignment: false });
    const roleResolver = makeFakeRoleResolver();
    const grantResolver = new PermissionGrantResolver(assignmentService, roleResolver);

    await grantResolver.hasGrant({ principalId: PRINCIPAL_ID, role: null, resource: RESOURCE, action: ACTION });

    expect(assignmentService.hasAssignment).toHaveBeenCalledWith({ principalId: PRINCIPAL_ID, resource: RESOURCE, action: ACTION });
  });
});

describe('PermissionGrantResolver — request validation', () => {
  let grantResolver;

  beforeEach(() => {
    grantResolver = new PermissionGrantResolver(makeFakeAssignmentService(), makeFakeRoleResolver());
  });

  it('throws InvalidGrantRequestError for a non-object request', async () => {
    await expect(grantResolver.hasGrant(null)).rejects.toThrow(InvalidGrantRequestError);
    await expect(grantResolver.hasGrant('nope')).rejects.toThrow(InvalidGrantRequestError);
  });

  it('throws InvalidGrantRequestError for a missing principalId', async () => {
    await expect(grantResolver.hasGrant({ resource: RESOURCE, action: ACTION })).rejects.toThrow(InvalidGrantRequestError);
  });

  it('throws InvalidGrantRequestError for a non-string, non-empty role', async () => {
    await expect(
      grantResolver.hasGrant({ principalId: PRINCIPAL_ID, role: 42, resource: RESOURCE, action: ACTION }),
    ).rejects.toThrow(InvalidGrantRequestError);
    await expect(
      grantResolver.hasGrant({ principalId: PRINCIPAL_ID, role: '', resource: RESOURCE, action: ACTION }),
    ).rejects.toThrow(InvalidGrantRequestError);
  });

  it('throws InvalidGrantRequestError for a missing resource or action', async () => {
    await expect(grantResolver.hasGrant({ principalId: PRINCIPAL_ID, action: ACTION })).rejects.toThrow(InvalidGrantRequestError);
    await expect(grantResolver.hasGrant({ principalId: PRINCIPAL_ID, resource: RESOURCE })).rejects.toThrow(InvalidGrantRequestError);
  });
});
