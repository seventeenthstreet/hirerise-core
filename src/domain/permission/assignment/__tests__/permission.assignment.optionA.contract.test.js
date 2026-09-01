'use strict';

/**
 * @file src/domain/permission/assignment/__tests__/permission.assignment.optionA.contract.test.js
 *
 * BLOCKER 3B — OPTION A IMPLEMENTATION
 *
 * Locks in the frozen product decision: a Permission Assignment
 * principal is any valid `public.users.id` — `user`, `contributor`,
 * `admin`, `super_admin`, and `MASTER_ADMIN` are all equally eligible
 * Assignment targets, and eligibility is never restricted by
 * Administrator lifecycle (`admin_principals`) membership.
 *
 * This is a contract test, not new coverage of assignment mechanics
 * already exercised by permission.assignment.service.test.js /
 * permission.assignment.validation.test.js — it exists specifically to
 * fail loudly if a future change narrows Option A into Option B (an
 * Administrator-only principal restriction) or reintroduces coupling
 * to `admin_principals`.
 */

const fs = require('fs');
const path = require('path');

const { RESOURCES, ACTIONS, PERMISSION_CATEGORIES, PERMISSION_STATUS, AUTHORIZATION_DECISIONS } = require('../../permission.constants');
const { PermissionAssignmentService } = require('../permission.assignment.service');
const { InMemoryAssignmentRepository } = require('../repository/permission.assignment.repository.inMemory');
const { validatePermissionRequestShape } = require('../permission.assignment.validation');

const { PUBLISHED } = PERMISSION_STATUS;

function makeEntry() {
  const resource = RESOURCES.ADMINISTRATION;
  const action = ACTIONS.VIEW;
  const identity = `${resource}:${action}`;
  return {
    id: 'p-admin-view',
    identity,
    name: identity,
    resource,
    action,
    category: PERMISSION_CATEGORIES.ADMINISTRATION,
    status: PUBLISHED,
    description: null,
    capabilityOwner: null,
    lifecycleStage: { status: PUBLISHED, label: 'Published', stageIndex: 2, isTerminal: false },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

function makeFakeRegistry(entry) {
  return {
    async getPermissionByIdentity(identity) {
      return identity === entry.identity ? entry : null;
    },
  };
}

function makeFakeEvaluationEngine() {
  return {
    async evaluate({ userId, resource, action }) {
      return {
        decision: {
          outcome: AUTHORIZATION_DECISIONS.ALLOW,
          context: {},
          reason: 'irrelevant to Assignment',
          decidedAt: new Date().toISOString(),
        },
        explanation: {
          permission: `${resource}:${action}`,
          resource,
          action,
          decision: AUTHORIZATION_DECISIONS.ALLOW,
          reason: 'irrelevant',
          metadata: { userId },
        },
      };
    },
  };
}

// Representative principalId per current role — these are ordinary
// `public.users.id` values; the string suffix is only for test
// readability, the Assignment layer treats every principalId the same
// (see the shape-only assertion below).
const PRINCIPALS_BY_ROLE = {
  user: 'u-role-user',
  contributor: 'u-role-contributor',
  admin: 'u-role-admin',
  super_admin: 'u-role-super-admin',
  MASTER_ADMIN: 'u-role-master-admin',
};

describe('BLOCKER 3B — Option A: Assignment principal eligibility contract', () => {
  test.each(Object.entries(PRINCIPALS_BY_ROLE))(
    'a %s-represented principal (%s) can be assigned a Permission',
    async (role, principalId) => {
      const entry = makeEntry();
      const service = new PermissionAssignmentService(
        makeFakeRegistry(entry),
        makeFakeEvaluationEngine(),
        new InMemoryAssignmentRepository(),
      );

      const assignment = await service.assignPermission({
        principalId,
        resource: entry.resource,
        action: entry.action,
      });

      expect(assignment.principalId).toBe(principalId);
      expect(assignment.permissionIdentity).toBe(entry.identity);
      expect(await service.hasAssignment({ principalId, resource: entry.resource, action: entry.action })).toBe(true);
    },
  );

  test('assignment eligibility does not depend on any role/type field — only shape validation runs', () => {
    // validatePermissionRequestShape() is the entire eligibility check
    // Assignment performs on principalId. Proving it accepts an
    // arbitrary opaque string (not just the five known role-tagged
    // fixtures above) demonstrates the Assignment layer has no allowlist
    // of eligible principal types.
    expect(() =>
      validatePermissionRequestShape({
        principalId: 'any-valid-users-id-whatsoever',
        resource: RESOURCES.ADMINISTRATION,
        action: ACTIONS.VIEW,
      }),
    ).not.toThrow();
  });

  test('Assignment eligibility is a distinct question from Administrator route authorization', async () => {
    // A successful Assignment says nothing about whether that principal
    // can reach any Administrator-only route: that is decided entirely
    // by that route's own Administrator lifecycle guard
    // (requireAdmin/requireAdministrator/requireMasterAdmin), composed
    // in front of requirePermission() at the route/mount level — never
    // by the Assignment Service. This test proves the Assignment
    // Service's public surface has no method that could answer a route-
    // authorization question (no admin_principals awareness at all).
    const service = new PermissionAssignmentService(
      makeFakeRegistry(makeEntry()),
      makeFakeEvaluationEngine(),
      new InMemoryAssignmentRepository(),
    );

    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(service)).filter((k) => k !== 'constructor');
    for (const method of surface) {
      expect(method.toLowerCase()).not.toContain('admin_principal');
      expect(method.toLowerCase()).not.toContain('lifecycle');
    }
  });

  describe('no admin_principals / Administrator-lifecycle coupling (structural)', () => {
    // Belt-and-braces static check: the Assignment domain's own source
    // must never reference admin_principals or a Supabase client. If a
    // future change adds either, it has silently narrowed Option A (or
    // reintroduced the exact coupling Blocker 3B's Decision Analysis
    // Report identified as absent) — this test exists to catch that
    // regression at the source level, not just at the behavioral level.
    const filesToCheck = [
      '../permission.assignment.service.js',
      '../permission.assignment.validation.js',
      '../permission.assignment.model.js',
      '../permission.assignment.policy.js',
      '../repository/permission.assignment.repository.inMemory.js',
    ];

    test.each(filesToCheck)('%s does not import supabase or an admin_principals repository', (relativePath) => {
      const absolutePath = path.join(__dirname, relativePath);
      const source = fs.readFileSync(absolutePath, 'utf8');

      // Checks actual code dependencies (require/import statements and
      // Supabase query builders), not prose — this file's own doc
      // comments legitimately name "admin_principals" to explain why it
      // is absent, so a bare string search would false-positive on
      // documentation. What must never appear is a real dependency on
      // it: a DIRECT import of the Supabase client itself, or of the
      // admin_principals repository/table.
      //
      // BLOCKER 3C: narrowed from a bare `supabase` substring match to
      // specifically the client module (`config/supabase`) and the
      // underlying SDK (`@supabase/supabase-js`). A bare substring match
      // also flagged `require('./repository/permission.assignment.repository.supabase')`
      // in permission.assignment.service.js — the certified persistent
      // AssignmentRepository implementation Blocker 3C's Target
      // Architecture requires the Service to depend on (Service ->
      // AssignmentRepository interface -> SupabaseAssignmentRepository).
      // That is the abstraction this domain is supposed to depend on;
      // what remains forbidden here is any of these five files reaching
      // past that abstraction to touch the Supabase client or
      // admin_principals directly — which the repository's own
      // encapsulated, lazy `getSupabase()` call
      // (permission.assignment.repository.supabase.js) does NOT expose
      // to any of the files this test checks.
      expect(source).not.toMatch(/require\(['"][^'"]*config\/supabase['"]\)/i);
      expect(source).not.toMatch(/require\(['"]@supabase\/supabase-js['"]\)/i);
      expect(source).not.toMatch(/require\(['"][^'"]*adminPrincipal[^'"]*['"]\)/i);
      expect(source).not.toMatch(/\.from\(\s*['"]admin_principals['"]\s*\)/);
    });
  });
});
