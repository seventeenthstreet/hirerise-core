'use strict';

/**
 * administrators.service.test.js — WP-ADMIN-05A
 *
 * The certified lifecycle repository (adminPrincipal.repository.js) and
 * the new directory repository are both mocked here — this is a pure
 * orchestration test. It asserts that every lifecycle mutation is
 * delegated verbatim to the certified repository (no reimplementation),
 * that the certified InvalidLifecycleTransitionError is surfaced as a 409,
 * and that an Administrator can never suspend/revoke themselves.
 *
 * Admin Authorization Role Reconciliation: also asserts the Auth
 * app_metadata projection (adminAuthSync.js#syncAdminRoleToAuth, mocked
 * below) is invoked for grant/reactivate only, always AFTER the
 * admin_principals mutation has already resolved, and that a sync failure
 * is surfaced on the response and recorded as its own audit event rather
 * than thrown.
 */

jest.mock('../../repository/adminPrincipal.repository', () => ({
  getPrincipal: jest.fn(),
  grant: jest.fn(),
  suspend: jest.fn(),
  reactivate: jest.fn(),
  revoke: jest.fn(),
}));

jest.mock('../administrators.repository', () => ({
  listPrincipals: jest.fn(),
  getUserProfiles: jest.fn(),
  listLifecycleAuditEvents: jest.fn(),
}));

jest.mock('../../bootstrap/adminAuthSync', () => ({
  syncAdminRoleToAuth: jest.fn(),
}));

jest.mock('../../../../utils/adminAuditLogger', () => ({
  logAdminAction: jest.fn().mockResolvedValue(undefined),
}));

const principalRepo = require('../../repository/adminPrincipal.repository');
const directoryRepo = require('../administrators.repository');
const { syncAdminRoleToAuth } = require('../../bootstrap/adminAuthSync');
const { logAdminAction } = require('../../../../utils/adminAuditLogger');
const { InvalidLifecycleTransitionError } = require('../../../../domain/admin/lifecycle/adminLifecycle.states');
const service = require('../administrators.service');

function principalRow(overrides = {}) {
  return {
    uid: 'target-1',
    role: 'admin',
    status: 'active',
    granted_by: 'master-1',
    granted_at: '2026-01-01T00:00:00.000Z',
    verified_at: '2026-01-01T00:00:00.000Z',
    last_action_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('administrators.service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    directoryRepo.getUserProfiles.mockResolvedValue(new Map());
    directoryRepo.listLifecycleAuditEvents.mockResolvedValue([]);
    syncAdminRoleToAuth.mockResolvedValue({ synchronized: true, error: null });
  });

  describe('listAdministrators', () => {
    it('composes directory rows with resolved user profiles', async () => {
      directoryRepo.listPrincipals.mockResolvedValue({ items: [principalRow()], total: 1 });
      directoryRepo.getUserProfiles.mockResolvedValue(
        new Map([['target-1', { email: 'a@b.com', displayName: 'Ada' }]])
      );

      const result = await service.listAdministrators({ limit: 10, offset: 0 });

      expect(result.total).toBe(1);
      expect(result.administrators[0]).toMatchObject({
        uid: 'target-1',
        email: 'a@b.com',
        displayName: 'Ada',
        status: 'active',
      });
    });
  });

  describe('getAdministrator', () => {
    it('throws 404 when no principal exists', async () => {
      principalRepo.getPrincipal.mockResolvedValue(null);
      await expect(service.getAdministrator('missing')).rejects.toMatchObject({ statusCode: 404 });
    });

    it('includes lifecycle history from the audit reader', async () => {
      principalRepo.getPrincipal.mockResolvedValue(principalRow());
      directoryRepo.listLifecycleAuditEvents.mockResolvedValue([
        { action: 'ADMIN_GRANTED', admin_id: 'master-1', created_at: '2026-01-01T00:00:00.000Z', metadata: {} },
      ]);

      const detail = await service.getAdministrator('target-1');
      expect(detail.lifecycleHistory).toHaveLength(1);
      expect(detail.lifecycleHistory[0]).toMatchObject({ action: 'ADMIN_GRANTED', actorId: 'master-1' });
    });
  });

  describe('lifecycle orchestration — delegates to the certified repository', () => {
    beforeEach(() => {
      principalRepo.getPrincipal.mockResolvedValue(principalRow());
    });

    it('grant() calls principalRepo.grant() with the same arguments', async () => {
      await service.grantAdministrator('target-1', 'admin', 'master-1');
      expect(principalRepo.grant).toHaveBeenCalledWith('target-1', 'admin', 'master-1');
    });

    it('suspend() calls principalRepo.suspend() with the same arguments', async () => {
      await service.suspendAdministrator('target-1', 'master-1', 'policy violation');
      expect(principalRepo.suspend).toHaveBeenCalledWith('target-1', 'master-1', 'policy violation');
    });

    it('reactivate() calls principalRepo.reactivate() with the same arguments', async () => {
      await service.reactivateAdministrator('target-1', 'master-1');
      expect(principalRepo.reactivate).toHaveBeenCalledWith('target-1', 'master-1');
    });

    it('revoke() calls principalRepo.revoke() with the same arguments', async () => {
      await service.revokeAdministrator('target-1', 'master-1');
      expect(principalRepo.revoke).toHaveBeenCalledWith('target-1', 'master-1');
    });

    it('maps InvalidLifecycleTransitionError to a 409 AppError', async () => {
      principalRepo.suspend.mockRejectedValue(new InvalidLifecycleTransitionError('suspend', 'revoked'));
      await expect(service.suspendAdministrator('target-1', 'master-1')).rejects.toMatchObject({
        statusCode: 409,
      });
    });
  });

  describe('self-lockout guard', () => {
    it('refuses to grant/change your own role without calling the repository', async () => {
      await expect(service.grantAdministrator('master-1', 'admin', 'master-1')).rejects.toMatchObject({
        statusCode: 403,
      });
      expect(principalRepo.grant).not.toHaveBeenCalled();
    });

    it('refuses to suspend yourself without calling the repository', async () => {
      await expect(service.suspendAdministrator('master-1', 'master-1')).rejects.toMatchObject({
        statusCode: 403,
      });
      expect(principalRepo.suspend).not.toHaveBeenCalled();
    });

    it('refuses to revoke yourself without calling the repository', async () => {
      await expect(service.revokeAdministrator('master-1', 'master-1')).rejects.toMatchObject({
        statusCode: 403,
      });
      expect(principalRepo.revoke).not.toHaveBeenCalled();
    });
  });

  describe('MASTER_ADMIN target protection', () => {
    // A different MASTER_ADMIN principal (uid !== actorId), so the
    // self-lockout guard above does not fire — this exercises the
    // separate target-role check.
    function masterAdminTargetRow(overrides = {}) {
      return principalRow({ uid: 'other-master', role: 'MASTER_ADMIN', ...overrides });
    }

    it('refuses to suspend a MASTER_ADMIN target without calling the repository', async () => {
      principalRepo.getPrincipal.mockResolvedValue(masterAdminTargetRow());

      await expect(service.suspendAdministrator('other-master', 'master-1')).rejects.toMatchObject({
        statusCode: 403,
      });
      expect(principalRepo.suspend).not.toHaveBeenCalled();
    });

    it('refuses to reactivate a MASTER_ADMIN target without calling the repository', async () => {
      principalRepo.getPrincipal.mockResolvedValue(masterAdminTargetRow({ status: 'suspended' }));

      await expect(service.reactivateAdministrator('other-master', 'master-1')).rejects.toMatchObject({
        statusCode: 403,
      });
      expect(principalRepo.reactivate).not.toHaveBeenCalled();
    });

    it('refuses to revoke a MASTER_ADMIN target without calling the repository', async () => {
      principalRepo.getPrincipal.mockResolvedValue(masterAdminTargetRow());

      await expect(service.revokeAdministrator('other-master', 'master-1')).rejects.toMatchObject({
        statusCode: 403,
      });
      expect(principalRepo.revoke).not.toHaveBeenCalled();
    });

    it('still allows a MASTER_ADMIN operator to revoke an ordinary ADMIN target', async () => {
      principalRepo.getPrincipal.mockResolvedValue(principalRow({ uid: 'target-1', role: 'admin' }));

      await service.revokeAdministrator('target-1', 'master-1');

      expect(principalRepo.revoke).toHaveBeenCalledWith('target-1', 'master-1');
    });
  });

  describe('Auth app_metadata projection (Admin Authorization Role Reconciliation)', () => {
    beforeEach(() => {
      principalRepo.getPrincipal.mockResolvedValue(principalRow());
      // Insulate against the preceding describe block's
      // `.mockRejectedValue(...)` (not `...Once`) on principalRepo.suspend —
      // jest.clearAllMocks() clears call history but not a previously set
      // implementation, so these mutation mocks are explicitly reset back
      // to a resolved default here regardless of prior test ordering.
      principalRepo.grant.mockResolvedValue(undefined);
      principalRepo.suspend.mockResolvedValue(undefined);
      principalRepo.reactivate.mockResolvedValue(undefined);
      principalRepo.revoke.mockResolvedValue(undefined);
    });

    describe('grantAdministrator', () => {
      it('syncs the granted role to Auth only after admin_principals.grant() has resolved', async () => {
        const callOrder = [];
        principalRepo.grant.mockImplementation(async () => { callOrder.push('grant'); });
        syncAdminRoleToAuth.mockImplementation(async () => { callOrder.push('sync'); return { synchronized: true, error: null }; });

        await service.grantAdministrator('target-1', 'admin', 'master-1');

        expect(callOrder).toEqual(['grant', 'sync']);
        expect(syncAdminRoleToAuth).toHaveBeenCalledWith('target-1', 'admin');
      });

      it('surfaces authSynchronized/authSyncError on the returned detail', async () => {
        syncAdminRoleToAuth.mockResolvedValue({ synchronized: true, error: null });

        const result = await service.grantAdministrator('target-1', 'admin', 'master-1');

        expect(result).toMatchObject({ authSynchronized: true, authSyncError: null });
      });

      it('records ADMIN_AUTH_SYNC_FAILED and surfaces the failure without throwing', async () => {
        syncAdminRoleToAuth.mockResolvedValue({ synchronized: false, error: 'no auth user' });

        const result = await service.grantAdministrator('target-1', 'admin', 'master-1');

        expect(result).toMatchObject({ authSynchronized: false, authSyncError: 'no auth user' });
        expect(logAdminAction).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'ADMIN_AUTH_SYNC_FAILED',
            adminId: 'master-1',
            entityId: 'target-1',
            metadata: expect.objectContaining({ stage: 'auth_metadata_sync', role: 'admin', error: 'no auth user' }),
          })
        );
      });

      it('does not call syncAdminRoleToAuth when the admin_principals mutation itself fails', async () => {
        principalRepo.grant.mockRejectedValueOnce(new InvalidLifecycleTransitionError('grant', 'revoked'));

        await expect(service.grantAdministrator('target-1', 'admin', 'master-1')).rejects.toMatchObject({
          statusCode: 409,
        });
        expect(syncAdminRoleToAuth).not.toHaveBeenCalled();
      });

      it('does not record an audit event when sync succeeds', async () => {
        syncAdminRoleToAuth.mockResolvedValue({ synchronized: true, error: null });

        await service.grantAdministrator('target-1', 'admin', 'master-1');

        expect(logAdminAction).not.toHaveBeenCalled();
      });
    });

    describe('reactivateAdministrator', () => {
      it('syncs Auth using the principal\'s existing role (reactivate does not change role)', async () => {
        principalRepo.getPrincipal.mockResolvedValue(principalRow({ role: 'super_admin' }));

        await service.reactivateAdministrator('target-1', 'master-1');

        expect(syncAdminRoleToAuth).toHaveBeenCalledWith('target-1', 'super_admin');
      });

      it('surfaces a sync failure without throwing', async () => {
        syncAdminRoleToAuth.mockResolvedValue({ synchronized: false, error: 'write failed' });

        const result = await service.reactivateAdministrator('target-1', 'master-1');

        expect(result).toMatchObject({ authSynchronized: false, authSyncError: 'write failed' });
      });

      it('does not call syncAdminRoleToAuth when the reactivate transition itself fails', async () => {
        principalRepo.reactivate.mockRejectedValueOnce(new InvalidLifecycleTransitionError('reactivate', 'revoked'));

        await expect(service.reactivateAdministrator('target-1', 'master-1')).rejects.toMatchObject({
          statusCode: 409,
        });
        expect(syncAdminRoleToAuth).not.toHaveBeenCalled();
      });
    });

    describe('suspendAdministrator / revokeAdministrator — no Auth projection', () => {
      it('suspend() never calls syncAdminRoleToAuth', async () => {
        await service.suspendAdministrator('target-1', 'master-1', 'policy violation');
        expect(syncAdminRoleToAuth).not.toHaveBeenCalled();
      });

      it('revoke() never calls syncAdminRoleToAuth', async () => {
        await service.revokeAdministrator('target-1', 'master-1');
        expect(syncAdminRoleToAuth).not.toHaveBeenCalled();
      });

      it('suspend()/revoke() responses carry no authSynchronized field', async () => {
        const suspendResult = await service.suspendAdministrator('target-1', 'master-1');
        const revokeResult = await service.revokeAdministrator('target-1', 'master-1');

        expect(suspendResult.authSynchronized).toBeUndefined();
        expect(revokeResult.authSynchronized).toBeUndefined();
      });
    });
  });
});
