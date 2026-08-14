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

const principalRepo = require('../../repository/adminPrincipal.repository');
const directoryRepo = require('../administrators.repository');
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
});
