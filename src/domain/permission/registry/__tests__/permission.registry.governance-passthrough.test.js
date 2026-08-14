'use strict';

/**
 * @file src/domain/permission/registry/__tests__/permission.registry.governance-passthrough.test.js
 *
 * WP-ADMIN-04F-04 — Enterprise Permission Governance Services
 *
 * Covers `applyLifecycleTransition()`, the minimal write passthrough
 * added to the Registry so the Governance Service never bypasses it
 * (Governance -> Registry -> Repository -> Database). Kept as its own
 * file rather than folded into permission.registry.test.js so the
 * existing WP-ADMIN-04F-03 test file — covering the certified read-only
 * Registry — stays untouched.
 */

const { RESOURCES, ACTIONS, PERMISSION_CATEGORIES, PERMISSION_STATUS } = require('../../permission.constants');
const { PermissionRegistry } = require('../permission.registry');
const { PermissionRegistryValidationError } = require('../permission.registry.errors');

function makePermission(overrides = {}) {
  const resource = overrides.resource ?? RESOURCES.JOB_LISTING;
  const action = overrides.action ?? ACTIONS.VIEW;
  return {
    id: overrides.id ?? 'p-1',
    name: overrides.name ?? `${resource}:${action}`,
    resource,
    action,
    category: overrides.category ?? PERMISSION_CATEGORIES.JOBS,
    status: overrides.status ?? PERMISSION_STATUS.PROPOSED,
    description: overrides.description ?? 'A permission',
    createdAt: overrides.createdAt ?? '2026-08-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-08-01T00:00:00.000Z',
  };
}

function makeFakeRepository(rows) {
  return {
    async update(id, updates) {
      const row = rows.find((r) => r.id === id);
      if (!row) return null;
      Object.assign(row, updates, { updatedAt: '2026-08-02T00:00:00.000Z' });
      return { ...row };
    },
  };
}

describe('PermissionRegistry.applyLifecycleTransition', () => {
  it('forwards the status change to the Repository and returns a decorated entry', async () => {
    const rows = [makePermission({ status: PERMISSION_STATUS.PROPOSED })];
    const registry = new PermissionRegistry(makeFakeRepository(rows));

    const updated = await registry.applyLifecycleTransition('p-1', PERMISSION_STATUS.APPROVED);

    expect(updated.status).toBe(PERMISSION_STATUS.APPROVED);
    expect(updated.identity).toBe('job_listing:view');
    expect(rows[0].status).toBe(PERMISSION_STATUS.APPROVED);
  });

  it('returns null when the Repository reports no matching row', async () => {
    const registry = new PermissionRegistry(makeFakeRepository([]));

    const updated = await registry.applyLifecycleTransition('does-not-exist', PERMISSION_STATUS.APPROVED);

    expect(updated).toBeNull();
  });

  it('rejects an empty id', async () => {
    const registry = new PermissionRegistry(makeFakeRepository([]));

    await expect(registry.applyLifecycleTransition('', PERMISSION_STATUS.APPROVED)).rejects.toThrow(
      PermissionRegistryValidationError,
    );
  });

  it('rejects an empty status', async () => {
    const registry = new PermissionRegistry(makeFakeRepository([]));

    await expect(registry.applyLifecycleTransition('p-1', '')).rejects.toThrow(PermissionRegistryValidationError);
  });

  it('performs no validation of the transition itself — that is the Governance layer\'s job', async () => {
    const rows = [makePermission({ status: PERMISSION_STATUS.PROPOSED })];
    const registry = new PermissionRegistry(makeFakeRepository(rows));

    // Skips straight to RETIRED — illegal under AUTH-04 §6, but this
    // method trusts its caller and applies it anyway.
    const updated = await registry.applyLifecycleTransition('p-1', PERMISSION_STATUS.RETIRED);

    expect(updated.status).toBe(PERMISSION_STATUS.RETIRED);
  });
});
