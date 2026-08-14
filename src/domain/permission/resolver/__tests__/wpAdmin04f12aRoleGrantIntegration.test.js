'use strict';

/**
 * @file src/domain/permission/resolver/__tests__/wpAdmin04f12aRoleGrantIntegration.test.js
 *
 * WP-ADMIN-04F-12A — Enterprise Role Permission Catalog Population
 *
 * WP-ADMIN-04F-12's diagnostic traced a production 403 across three
 * collaborators (RolePermissionResolver -> PermissionGrantResolver ->
 * requirePermission()) to one root cause: an empty ROLE_PERMISSION_MAP.
 * Each collaborator already has its own unit tests exercising it in
 * isolation against fakes (rolePermission.resolver.test.js,
 * permissionGrant.resolver.test.js, permission.middleware.test.js) — this
 * file instead exercises them wired together against the REAL, now-
 * populated `ROLE_PERMISSION_MAP` and REAL `RolePermissionResolver` /
 * `PermissionGrantResolver` (only the Evaluation Engine and Assignment
 * Service are faked, since exercising real governance/persistence is out
 * of this WP's scope), so a regression in the data itself — not just the
 * collaborators' logic — would be caught here.
 */

const { RESOURCES, CORE_ACTIONS, AUTHORIZATION_DECISIONS } = require('../../permission.constants');
const { buildPermissionName } = require('../../permission.model');
const { INITIAL_PERMISSION_CATALOG } = require('../../permission.catalog');
const { RolePermissionResolver } = require('../rolePermission.resolver');
const { PermissionGrantResolver } = require('../permissionGrant.resolver');
const { ROLES } = require('../roles.constants');
const { requirePermission } = require('../../middleware/permission.middleware');

const EXPECTED_ADMIN_IDENTITIES = INITIAL_PERMISSION_CATALOG.map((p) => p.name).sort();

function makeFakeAssignmentService({ hasAssignment = false } = {}) {
  return { async hasAssignment() { return hasAssignment; } };
}

function makeFakeEvaluationEngine({ outcome = AUTHORIZATION_DECISIONS.ALLOW, reason = 'because' } = {}) {
  return { async evaluate() { return { decision: { outcome, reason }, explanation: {} }; } };
}

function makeReq(overrides = {}) {
  return { user: { id: 'user-1', role: 'user' }, requestId: 'req-1', ...overrides };
}

function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('WP-ADMIN-04F-12A — RolePermissionResolver.resolve() against the real, populated mapping', () => {
  const resolver = new RolePermissionResolver(); // real singleton mapping

  it('resolves admin to exactly the Initial Enterprise Permission Catalog identities', () => {
    expect(resolver.resolve(ROLES.ADMIN).slice().sort()).toEqual(EXPECTED_ADMIN_IDENTITIES);
  });

  it('resolves super_admin to exactly the Initial Enterprise Permission Catalog identities', () => {
    expect(resolver.resolve(ROLES.SUPER_ADMIN).slice().sort()).toEqual(EXPECTED_ADMIN_IDENTITIES);
  });

  it('resolves user to an empty array (no invented scope)', () => {
    expect(resolver.resolve(ROLES.USER)).toEqual([]);
  });

  it('resolves contributor to an empty array (no invented scope)', () => {
    expect(resolver.resolve(ROLES.CONTRIBUTOR)).toEqual([]);
  });
});

describe('WP-ADMIN-04F-12A — PermissionGrantResolver.hasGrant() via Role derivation only', () => {
  // Real RolePermissionResolver (default mapping) + real PermissionGrantResolver,
  // fake Assignment Service forced to report no explicit Assignment — isolates
  // the Role-derivation path this WP fixed.
  const assignmentService = makeFakeAssignmentService({ hasAssignment: false });
  const grantResolver = new PermissionGrantResolver(assignmentService);

  it.each([CORE_ACTIONS.VIEW, CORE_ACTIONS.CREATE, CORE_ACTIONS.DELETE])(
    'grants admin administration:%s purely through Role derivation',
    async (action) => {
      const granted = await grantResolver.hasGrant({
        principalId: 'admin-user-1',
        role: ROLES.ADMIN,
        resource: RESOURCES.ADMINISTRATION,
        action,
      });
      expect(granted).toBe(true);
    },
  );

  it.each([CORE_ACTIONS.VIEW, CORE_ACTIONS.CREATE, CORE_ACTIONS.DELETE])(
    'grants super_admin administration:%s purely through Role derivation',
    async (action) => {
      const granted = await grantResolver.hasGrant({
        principalId: 'super-admin-user-1',
        role: ROLES.SUPER_ADMIN,
        resource: RESOURCES.ADMINISTRATION,
        action,
      });
      expect(granted).toBe(true);
    },
  );

  it('still denies a plain user for administration:view (no regression to the "no invented scope" boundary)', async () => {
    const granted = await grantResolver.hasGrant({
      principalId: 'plain-user-1',
      role: ROLES.USER,
      resource: RESOURCES.ADMINISTRATION,
      action: CORE_ACTIONS.VIEW,
    });
    expect(granted).toBe(false);
  });
});

describe('WP-ADMIN-04F-12A — Authorization middleware end-to-end (real resolver + grant resolver, fake Evaluation/Assignment)', () => {
  // Real RolePermissionResolver + real PermissionGrantResolver, wired into
  // requirePermission() via its dependency-injection seam. Evaluation
  // Engine is faked to Allow (governance-level check is out of this WP's
  // scope — WP-ADMIN-04F-12 already confirmed it passes); Assignment
  // Service is faked to report no explicit Assignment, isolating the
  // Role-derivation path this WP populated.
  function makeMiddleware(action) {
    const assignmentService = makeFakeAssignmentService({ hasAssignment: false });
    const grantResolver = new PermissionGrantResolver(assignmentService);
    const evaluationEngine = makeFakeEvaluationEngine();
    return requirePermission(RESOURCES.ADMINISTRATION, action, { grantResolver, evaluationEngine });
  }

  it('calls next() (HTTP 200 path) for an authenticated admin requesting administration:view', async () => {
    const middleware = makeMiddleware(CORE_ACTIONS.VIEW);
    const req = makeReq({ user: { id: 'admin-1', role: ROLES.ADMIN } });
    const res = makeRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each([CORE_ACTIONS.VIEW, CORE_ACTIONS.CREATE, CORE_ACTIONS.DELETE])(
    'calls next() for an authenticated super_admin requesting administration:%s',
    async (action) => {
      const middleware = makeMiddleware(action);
      const req = makeReq({ user: { id: 'super-admin-1', role: ROLES.SUPER_ADMIN } });
      const res = makeRes();
      const next = jest.fn();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalledWith();
    },
  );

  it('returns HTTP 403 for an authenticated plain user requesting administration:view (regression guard on scope)', async () => {
    const middleware = makeMiddleware(CORE_ACTIONS.VIEW);
    const req = makeReq({ user: { id: 'user-1', role: ROLES.USER } });
    const res = makeRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('WP-ADMIN-04F-12A — identity derivation consistency', () => {
  it('every identity RolePermissionResolver derives for admin matches buildPermissionName() on the same pair', () => {
    const resolver = new RolePermissionResolver();
    const identities = resolver.resolve(ROLES.ADMIN);
    for (const permission of INITIAL_PERMISSION_CATALOG) {
      expect(identities).toContain(buildPermissionName(permission.resource, permission.action));
    }
  });
});
