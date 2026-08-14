'use strict';

/**
 * @file src/domain/permission/governance/__tests__/permission.governance.service.test.js
 *
 * WP-ADMIN-04F-04 — Enterprise Permission Governance Services
 *
 * Exercises PermissionGovernanceService against a fake, constructor-
 * injected Registry (never a real Repository, never Supabase) — mirrors
 * ../../registry/__tests__/permission.registry.test.js's own "fake
 * satisfying the method surface" convention, scoped one layer up: this
 * fake satisfies the two Registry methods Governance actually calls
 * (`getPermission`, `applyLifecycleTransition`), backed by an in-memory
 * array.
 */

const { RESOURCES, ACTIONS, PERMISSION_CATEGORIES, PERMISSION_STATUS } = require('../../permission.constants');
const { PermissionGovernanceService } = require('../permission.governance.service');
const {
  InvalidLifecycleTransitionError,
  PermissionAlreadyPublishedError,
  PermissionAlreadyRetiredError,
  GovernanceValidationError,
  GovernanceConflictError,
} = require('../permission.governance.errors');

const {
  PROPOSED, APPROVED, PUBLISHED, ADOPTED, DEPRECATED, RETIRED,
} = PERMISSION_STATUS;

function makeEntry(overrides = {}) {
  const resource = overrides.resource ?? RESOURCES.JOB_LISTING;
  const action = overrides.action ?? ACTIONS.VIEW;
  const identity = overrides.identity ?? `${resource}:${action}`;
  return {
    id: overrides.id ?? 'p-1',
    identity,
    name: identity,
    resource,
    action,
    category: overrides.category ?? PERMISSION_CATEGORIES.JOBS,
    status: overrides.status ?? PROPOSED,
    description: overrides.description ?? 'A permission',
    capabilityOwner: overrides.capabilityOwner ?? null,
    lifecycleStage: overrides.lifecycleStage ?? null,
    createdAt: overrides.createdAt ?? '2026-08-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-08-01T00:00:00.000Z',
  };
}

/**
 * A minimal fake satisfying only the Registry surface Governance
 * consumes. Applying a transition mutates the in-memory row directly,
 * the same way the real Registry's `applyLifecycleTransition()` would
 * reflect a Repository write.
 */
function makeFakeRegistry(rows = []) {
  return {
    async getPermission(id) {
      return rows.find((r) => r.id === id) ?? null;
    },
    async applyLifecycleTransition(id, status) {
      const row = rows.find((r) => r.id === id);
      if (!row) return null;
      row.status = status;
      row.updatedAt = '2026-08-02T00:00:00.000Z';
      return { ...row };
    },
  };
}

describe('PermissionGovernanceService lifecycle operations', () => {
  it('approve(): Proposal -> Approval', async () => {
    const rows = [makeEntry({ status: PROPOSED })];
    const service = new PermissionGovernanceService(makeFakeRegistry(rows));

    const updated = await service.approve('p-1');

    expect(updated.status).toBe(APPROVED);
  });

  it('publish(): Approval -> Publication', async () => {
    const rows = [makeEntry({ status: APPROVED })];
    const service = new PermissionGovernanceService(makeFakeRegistry(rows));

    const updated = await service.publish('p-1');

    expect(updated.status).toBe(PUBLISHED);
  });

  it('adopt(): Publication -> Adoption', async () => {
    const rows = [makeEntry({ status: PUBLISHED })];
    const service = new PermissionGovernanceService(makeFakeRegistry(rows));

    const updated = await service.adopt('p-1');

    expect(updated.status).toBe(ADOPTED);
  });

  it('deprecate(): Adoption -> Deprecation', async () => {
    const rows = [makeEntry({ status: ADOPTED })];
    const service = new PermissionGovernanceService(makeFakeRegistry(rows));

    const updated = await service.deprecate('p-1');

    expect(updated.status).toBe(DEPRECATED);
  });

  it('retire(): Deprecation -> Retirement', async () => {
    const rows = [makeEntry({ status: DEPRECATED })];
    const service = new PermissionGovernanceService(makeFakeRegistry(rows));

    const updated = await service.retire('p-1');

    expect(updated.status).toBe(RETIRED);
  });

  it('transitionTo(): generic dispatch applies the same validation as the named operations', async () => {
    const rows = [makeEntry({ status: PROPOSED })];
    const service = new PermissionGovernanceService(makeFakeRegistry(rows));

    const updated = await service.transitionTo('p-1', APPROVED);

    expect(updated.status).toBe(APPROVED);
  });
});

describe('PermissionGovernanceService transition validation', () => {
  it('rejects skipping a stage', async () => {
    const rows = [makeEntry({ status: PROPOSED })];
    const service = new PermissionGovernanceService(makeFakeRegistry(rows));

    await expect(service.publish('p-1')).rejects.toThrow(InvalidLifecycleTransitionError);
  });

  it('rejects a backward transition', async () => {
    const rows = [makeEntry({ status: ADOPTED })];
    const service = new PermissionGovernanceService(makeFakeRegistry(rows));

    await expect(service.transitionTo('p-1', PROPOSED)).rejects.toThrow(InvalidLifecycleTransitionError);
  });

  it('rejects any transition once a Permission is retired', async () => {
    const rows = [makeEntry({ status: RETIRED })];
    const service = new PermissionGovernanceService(makeFakeRegistry(rows));

    await expect(service.transitionTo('p-1', PUBLISHED)).rejects.toThrow(PermissionAlreadyRetiredError);
  });

  it('rejects duplicate/terminal-state retire() with a specific error', async () => {
    const rows = [makeEntry({ status: RETIRED })];
    const service = new PermissionGovernanceService(makeFakeRegistry(rows));

    await expect(service.retire('p-1')).rejects.toThrow(PermissionAlreadyRetiredError);
  });

  it('rejects duplicate publish() with a specific error', async () => {
    const rows = [makeEntry({ status: PUBLISHED })];
    const service = new PermissionGovernanceService(makeFakeRegistry(rows));

    await expect(service.publish('p-1')).rejects.toThrow(PermissionAlreadyPublishedError);
  });

  it('validateTransition() reports a valid forward transition without applying it', async () => {
    const rows = [makeEntry({ status: PROPOSED })];
    const service = new PermissionGovernanceService(makeFakeRegistry(rows));

    const report = await service.validateTransition('p-1', APPROVED);

    expect(report).toEqual({
      valid: true, fromStatus: PROPOSED, toStatus: APPROVED, violations: [],
    });
    // Unapplied: the underlying row is untouched.
    expect(rows[0].status).toBe(PROPOSED);
  });

  it('validateTransition() reports violations for an illegal transition', async () => {
    const rows = [makeEntry({ status: PROPOSED })];
    const service = new PermissionGovernanceService(makeFakeRegistry(rows));

    const report = await service.validateTransition('p-1', PUBLISHED);

    expect(report.valid).toBe(false);
    expect(report.violations).toHaveLength(1);
  });
});

describe('PermissionGovernanceService governance rules', () => {
  it('throws GovernanceValidationError for an unknown Permission id', async () => {
    const service = new PermissionGovernanceService(makeFakeRegistry([]));

    await expect(service.approve('does-not-exist')).rejects.toThrow(GovernanceValidationError);
  });

  it('throws GovernanceValidationError for a missing/empty id', async () => {
    const service = new PermissionGovernanceService(makeFakeRegistry([]));

    await expect(service.approve('')).rejects.toThrow(GovernanceValidationError);
  });

  it('rejects an attempt to change Permission Identity through a transition', async () => {
    const rows = [makeEntry({ status: PROPOSED, identity: 'job_listing:view' })];
    const service = new PermissionGovernanceService(makeFakeRegistry(rows));

    await expect(
      service._transition('p-1', PROPOSED, APPROVED, { requestedIdentity: 'job_listing:delete' }),
    ).rejects.toThrow(GovernanceConflictError);
  });

  it('surfaces a conflict if the Registry reports no row during an otherwise-valid transition', async () => {
    const rows = [makeEntry({ status: PROPOSED })];
    const registry = makeFakeRegistry(rows);
    registry.applyLifecycleTransition = async () => null;
    const service = new PermissionGovernanceService(registry);

    await expect(service.approve('p-1')).rejects.toThrow(GovernanceConflictError);
  });
});
