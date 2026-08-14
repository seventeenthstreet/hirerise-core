'use strict';

const {
  createAdminPrincipalsSupabaseMock,
} = require('../../repository/testHelpers/adminPrincipalsSupabaseMock');

let mock;

jest.mock('../../../../config/supabase', () => ({
  get supabase() {
    return mock;
  },
}));

// adminAuditLogger writes to Supabase too; stub it out entirely so these
// are unit tests of bootstrap decision logic, not the audit pipeline
// (which already has its own tests).
jest.mock('../../../../utils/adminAuditLogger', () => ({
  logAdminAction: jest.fn().mockResolvedValue(undefined),
}));

const { STATES } = require('../../../../domain/admin/lifecycle/adminLifecycle.states');
const { logAdminAction } = require('../../../../utils/adminAuditLogger');
const repo = require('../../repository/adminPrincipal.repository');
const {
  bootstrapMasterAdmin,
  checkEligibility,
  BootstrapAlreadyCompletedError,
  BootstrapInputError,
} = require('../adminBootstrap.service');

describe('adminBootstrap.service', () => {
  beforeEach(() => {
    mock = createAdminPrincipalsSupabaseMock([]);
    logAdminAction.mockClear();
  });

  describe('fresh deployment (no rows at all)', () => {
    it('is eligible', async () => {
      await expect(checkEligibility('new-admin-uid')).resolves.toEqual({ eligible: true });
    });

    it('creates an active MASTER_ADMIN principal via the certified grant() path', async () => {
      const result = await bootstrapMasterAdmin({ uid: 'new-admin-uid', email: 'root@hirerise.example' });

      expect(result).toEqual({ success: true, uid: 'new-admin-uid', role: 'MASTER_ADMIN' });

      const row = await repo.getPrincipal('new-admin-uid');
      expect(row).toMatchObject({
        uid: 'new-admin-uid',
        role: 'MASTER_ADMIN',
        status: STATES.ACTIVE,
        granted_by: 'system:bootstrap',
      });
    });

    it('emits both the standard ADMIN_GRANTED lifecycle audit event and the additive ADMIN_BOOTSTRAPPED event', async () => {
      await bootstrapMasterAdmin({ uid: 'new-admin-uid' });

      const actions = logAdminAction.mock.calls.map(([event]) => event.action);
      expect(actions).toContain('ADMIN_GRANTED');
      expect(actions).toContain('ADMIN_BOOTSTRAPPED');
    });
  });

  describe('repeat execution prevention', () => {
    it('refuses when an active Administrator already exists, and does not touch that row', async () => {
      mock = createAdminPrincipalsSupabaseMock([
        {
          uid: 'existing-admin',
          role: 'MASTER_ADMIN',
          status: STATES.ACTIVE,
          granted_by: 'bootstrap',
          granted_at: new Date().toISOString(),
        },
      ]);

      await expect(bootstrapMasterAdmin({ uid: 'someone-else' })).rejects.toBeInstanceOf(
        BootstrapAlreadyCompletedError
      );

      // The pre-existing admin must be completely untouched.
      const row = await repo.getPrincipal('existing-admin');
      expect(row.status).toBe(STATES.ACTIVE);

      // And bootstrap must not have created a second principal either.
      const attempted = await repo.getPrincipal('someone-else');
      expect(attempted).toBeNull();
    });

    it('refuses re-running bootstrap for the same uid after it already succeeded', async () => {
      await bootstrapMasterAdmin({ uid: 'first-run-uid' });

      await expect(bootstrapMasterAdmin({ uid: 'first-run-uid' })).rejects.toBeInstanceOf(
        BootstrapAlreadyCompletedError
      );
    });
  });

  describe('never silently overwrites/resurrects a non-active row', () => {
    it.each([STATES.SUSPENDED, STATES.REVOKED, STATES.EXPIRED])(
      'refuses when a %s row already exists for the target uid, even with zero active admins',
      async (status) => {
        mock = createAdminPrincipalsSupabaseMock([
          {
            uid: 'target-uid',
            role: 'admin',
            status,
            granted_by: 'someone',
            granted_at: new Date().toISOString(),
          },
        ]);

        await expect(bootstrapMasterAdmin({ uid: 'target-uid' })).rejects.toBeInstanceOf(
          BootstrapAlreadyCompletedError
        );

        const row = await repo.getPrincipal('target-uid');
        expect(row.status).toBe(status); // untouched
      }
    );
  });

  describe('input validation', () => {
    it.each([undefined, null, ''])('rejects a missing uid (%p)', async (uid) => {
      await expect(bootstrapMasterAdmin({ uid })).rejects.toBeInstanceOf(BootstrapInputError);
    });
  });

  describe('failure handling', () => {
    it('does not emit ADMIN_BOOTSTRAPPED if the underlying grant() throws', async () => {
      jest.spyOn(repo, 'grant').mockRejectedValueOnce(new Error('db unreachable'));

      await expect(bootstrapMasterAdmin({ uid: 'new-admin-uid' })).rejects.toThrow('db unreachable');

      const actions = logAdminAction.mock.calls.map(([event]) => event.action);
      expect(actions).not.toContain('ADMIN_BOOTSTRAPPED');
    });
  });
});
