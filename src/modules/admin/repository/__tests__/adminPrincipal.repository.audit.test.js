'use strict';

/**
 * adminPrincipal.repository.audit.test.js — WP-ADMIN-04F-18C
 *
 * Verifies that every Administrator lifecycle transition now emits a
 * persisted audit event via the existing, already-certified
 * logAdminAction() / admin_logs infrastructure — without re-testing the
 * lifecycle state machine itself (see adminPrincipal.repository.lifecycle.test.js,
 * which is untouched by this work package and must continue to pass
 * unmodified).
 */

const { createAdminPrincipalsSupabaseMock } = require('../testHelpers/adminPrincipalsSupabaseMock');

let mock;

jest.mock('../../../../config/supabase', () => ({
  get supabase() {
    return mock;
  },
}));

const mockLogAdminAction = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../../utils/adminAuditLogger', () => ({
  logAdminAction: (...args) => mockLogAdminAction(...args),
}));

const { STATES } = require('../../../../domain/admin/lifecycle/adminLifecycle.states');
const repo = require('../adminPrincipal.repository');

function baseRow(overrides = {}) {
  return {
    uid: 'admin-1',
    role: 'admin',
    status: STATES.ACTIVE,
    granted_by: 'system',
    granted_at: new Date().toISOString(),
    verified_at: new Date().toISOString(),
    last_action_at: new Date().toISOString(),
    is_active: true,
    ...overrides,
  };
}

// emitLifecycleAudit() is fire-and-forget (`void logAdminAction(...)`), but
// it invokes logAdminAction() synchronously before the repository method's
// own promise resolves, so awaiting the repository call is sufficient —
// no extra tick is needed. flushAudit() exists only for readability.
async function flushAudit() {
  await Promise.resolve();
}

describe('adminPrincipal.repository — audit generation (WP-ADMIN-04F-18C)', () => {
  beforeEach(() => {
    mock = createAdminPrincipalsSupabaseMock([baseRow()]);
    mockLogAdminAction.mockClear();
  });

  it('emits ADMIN_GRANTED for a brand-new principal', async () => {
    await repo.grant('admin-2', 'admin', 'master-1');
    await flushAudit();

    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        adminId: 'master-1',
        action: 'ADMIN_GRANTED',
        entityType: 'admin_principal',
        entityId: 'admin-2',
        metadata: expect.objectContaining({ previousStatus: null, newStatus: 'active', newRole: 'admin' }),
      })
    );
  });

  it('emits ADMIN_GRANTED (not role-changed) when re-granting the same role to a revoked principal', async () => {
    await repo.revoke('admin-1', 'master-1');
    mockLogAdminAction.mockClear();

    await repo.grant('admin-1', 'admin', 'master-1');
    await flushAudit();

    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ADMIN_GRANTED' })
    );
  });

  it('emits ADMIN_ROLE_CHANGED instead of ADMIN_GRANTED when a re-grant changes the role', async () => {
    // NOTE: the certified lifecycle state machine (adminLifecycle.states.js)
    // only permits `grant` from [null, revoked, expired, suspended] — never
    // from `active`. So a role change can only be observed today via a
    // grant-driven reactivation with a different role than the principal
    // previously held; "change an active admin's role in place" is not a
    // reachable code path in this repository, and this test does not
    // invent one.
    await repo.suspend('admin-1', 'master-1');
    mockLogAdminAction.mockClear();

    await repo.grant('admin-1', 'super_admin', 'master-1');
    await flushAudit();

    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ADMIN_ROLE_CHANGED',
        entityId: 'admin-1',
        metadata: expect.objectContaining({
          previousStatus: 'suspended',
          previousRole: 'admin',
          newRole: 'super_admin',
        }),
      })
    );
    // Must not also emit ADMIN_GRANTED for the same call.
    expect(mockLogAdminAction).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ADMIN_GRANTED' })
    );
  });

  it('emits ADMIN_SUSPENDED with the reason', async () => {
    await repo.suspend('admin-1', 'master-1', 'policy violation');
    await flushAudit();

    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        adminId: 'master-1',
        action: 'ADMIN_SUSPENDED',
        entityId: 'admin-1',
        metadata: expect.objectContaining({
          previousStatus: 'active',
          newStatus: 'suspended',
          reason: 'policy violation',
        }),
      })
    );
  });

  it('emits ADMIN_REACTIVATED', async () => {
    await repo.suspend('admin-1', 'master-1');
    mockLogAdminAction.mockClear();

    await repo.reactivate('admin-1', 'master-1');
    await flushAudit();

    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ADMIN_REACTIVATED',
        metadata: expect.objectContaining({ previousStatus: 'suspended', newStatus: 'active' }),
      })
    );
  });

  it('emits ADMIN_REVOKED', async () => {
    await repo.revoke('admin-1', 'master-1');
    await flushAudit();

    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ADMIN_REVOKED',
        metadata: expect.objectContaining({ previousStatus: 'active', newStatus: 'revoked' }),
      })
    );
  });

  it('emits ADMIN_EXPIRED for a direct expire() call', async () => {
    await repo.expire('admin-1');
    await flushAudit();

    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        adminId: 'system',
        action: 'ADMIN_EXPIRED',
        metadata: expect.objectContaining({ expiryReason: 'expires_at_passed' }),
      })
    );
  });

  it('emits ADMIN_EXPIRED for automatic lazy expiry inside verify()', async () => {
    mock.__setRows([
      baseRow({ expires_at: new Date(Date.now() - 1000).toISOString() }),
    ]);

    await repo.verify('admin-1');
    await flushAudit();

    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ADMIN_EXPIRED', entityId: 'admin-1' })
    );
  });

  it('emits ADMIN_SESSION_REFRESHED on refresh of an existing active principal', async () => {
    await repo.refreshSession('admin-1');
    await flushAudit();

    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        adminId: 'admin-1',
        action: 'ADMIN_SESSION_REFRESHED',
        entityId: 'admin-1',
        metadata: expect.objectContaining({ autoProvisioned: false }),
      })
    );
  });

  it('emits ADMIN_SESSION_REFRESHED (autoProvisioned) when a principal is auto-provisioned', async () => {
    mock.__setRows([]);

    await repo.refreshSession('new-admin');
    await flushAudit();

    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ADMIN_SESSION_REFRESHED',
        entityId: 'new-admin',
        metadata: expect.objectContaining({ autoProvisioned: true }),
      })
    );
  });

  it('does not emit an audit event when refreshSession no-ops on a non-active principal', async () => {
    mock.__setRows([baseRow({ status: STATES.SUSPENDED })]);

    await repo.refreshSession('admin-1');
    await flushAudit();

    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it('a logAdminAction rejection does not fail or alter the lifecycle mutation (fail-open-on-audit)', async () => {
    mockLogAdminAction.mockRejectedValueOnce(new Error('audit store unavailable'));

    await expect(repo.suspend('admin-1', 'master-1')).resolves.toBeUndefined();

    const row = await repo.getPrincipal('admin-1');
    expect(row.status).toBe(STATES.SUSPENDED);
  });
});
