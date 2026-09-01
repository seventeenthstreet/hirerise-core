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

// adminAuthSync talks to Supabase Auth's admin API (auth.admin.getUserById /
// updateUserById), which is outside the scope of the lightweight
// admin_principals query-builder mock above. Stubbed here so these remain
// unit tests of bootstrap decision logic; the success/failure branches
// below drive it directly via the mock's return value.
jest.mock('../adminAuthSync', () => ({
  syncAdminRoleToAuth: jest.fn().mockResolvedValue({ synchronized: true, error: null }),
}));

const { STATES } = require('../../../../domain/admin/lifecycle/adminLifecycle.states');
const { logAdminAction } = require('../../../../utils/adminAuditLogger');
const { syncAdminRoleToAuth } = require('../adminAuthSync');
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
    syncAdminRoleToAuth.mockClear();
    syncAdminRoleToAuth.mockResolvedValue({ synchronized: true, error: null });
  });

  describe('fresh deployment (no rows at all)', () => {
    it('is eligible', async () => {
      await expect(checkEligibility('new-admin-uid')).resolves.toEqual({ eligible: true });
    });

    it('creates an active MASTER_ADMIN principal via the certified grant() path', async () => {
      const result = await bootstrapMasterAdmin({ uid: 'new-admin-uid', email: 'root@hirerise.example' });

      expect(result).toEqual({
        success: true,
        uid: 'new-admin-uid',
        role: 'MASTER_ADMIN',
        authSynchronized: true,
        authSyncError: null,
      });

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

    it('projects the granted role onto Auth app_metadata via adminAuthSync', async () => {
      await bootstrapMasterAdmin({ uid: 'new-admin-uid' });

      expect(syncAdminRoleToAuth).toHaveBeenCalledWith('new-admin-uid', 'MASTER_ADMIN');
    });
  });

  describe('MASTER_ADMIN-scoped eligibility (WP-ADMIN-IMP-07)', () => {
    it('remains eligible when active ADMIN (non-MASTER_ADMIN) principals exist and no MASTER_ADMIN exists — the deadlock this work package resolves', async () => {
      mock = createAdminPrincipalsSupabaseMock([
        {
          uid: 'existing-admin-1',
          role: 'admin',
          status: STATES.ACTIVE,
          granted_by: 'someone',
          granted_at: new Date().toISOString(),
        },
        {
          uid: 'existing-admin-2',
          role: 'super_admin',
          status: STATES.ACTIVE,
          granted_by: 'someone',
          granted_at: new Date().toISOString(),
        },
      ]);

      await expect(checkEligibility('new-master-uid')).resolves.toEqual({ eligible: true });

      const result = await bootstrapMasterAdmin({ uid: 'new-master-uid' });
      expect(result.role).toBe('MASTER_ADMIN');

      // The pre-existing ADMIN principals must be completely untouched.
      const admin1 = await repo.getPrincipal('existing-admin-1');
      const admin2 = await repo.getPrincipal('existing-admin-2');
      expect(admin1).toMatchObject({ role: 'admin', status: STATES.ACTIVE });
      expect(admin2).toMatchObject({ role: 'super_admin', status: STATES.ACTIVE });
    });

    it('is ineligible when an active MASTER_ADMIN already exists, regardless of other principals', async () => {
      mock = createAdminPrincipalsSupabaseMock([
        {
          uid: 'existing-admin',
          role: 'admin',
          status: STATES.ACTIVE,
          granted_by: 'someone',
          granted_at: new Date().toISOString(),
        },
        {
          uid: 'existing-master',
          role: 'MASTER_ADMIN',
          status: STATES.ACTIVE,
          granted_by: 'bootstrap',
          granted_at: new Date().toISOString(),
        },
      ]);

      await expect(checkEligibility('someone-else')).resolves.toEqual({
        eligible: false,
        reason: expect.stringContaining('MASTER_ADMIN already exists'),
      });
    });

    it('is eligible when a MASTER_ADMIN row exists but is not active (suspended/revoked/expired)', async () => {
      mock = createAdminPrincipalsSupabaseMock([
        {
          uid: 'former-master',
          role: 'MASTER_ADMIN',
          status: STATES.REVOKED,
          granted_by: 'bootstrap',
          granted_at: new Date().toISOString(),
        },
      ]);

      await expect(checkEligibility('new-master-uid')).resolves.toEqual({ eligible: true });
    });
  });

  describe('repeat execution prevention', () => {
    it('refuses when an active MASTER_ADMIN already exists, and does not touch that row', async () => {
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

    it('propagates a non-concurrency DB error from hasActiveMasterAdmin (fail-closed)', async () => {
      jest.spyOn(repo, 'hasActiveMasterAdmin').mockRejectedValueOnce(new Error('connection reset'));

      await expect(bootstrapMasterAdmin({ uid: 'new-admin-uid' })).rejects.toThrow('connection reset');

      // Fail-closed: no principal should have been created.
      const row = await repo.getPrincipal('new-admin-uid');
      expect(row).toBeNull();
    });
  });

  describe('concurrency (WP-ADMIN-IMP-07 §8)', () => {
    it('maps a Postgres unique_violation (23505) on the grant write to BootstrapAlreadyCompletedError', async () => {
      const uniqueViolation = new Error(
        'duplicate key value violates unique constraint "admin_principals_single_active_master_admin_idx"'
      );
      uniqueViolation.code = '23505';

      jest.spyOn(repo, 'grant').mockRejectedValueOnce(uniqueViolation);

      await expect(bootstrapMasterAdmin({ uid: 'racer-b' })).rejects.toBeInstanceOf(
        BootstrapAlreadyCompletedError
      );

      // Losing the DB race must not emit ADMIN_BOOTSTRAPPED (grant() itself
      // threw, so the repository write never committed for this uid).
      const actions = logAdminAction.mock.calls.map(([event]) => event.action);
      expect(actions).not.toContain('ADMIN_BOOTSTRAPPED');
    });

    it('end-to-end: a simulated 23505 from the real (unmocked) grant() insert() still reaches BootstrapAlreadyCompletedError', async () => {
      // Unlike the test above (which stubs repo.grant() directly to prove
      // the mapping logic in isolation), this one exercises the REAL
      // grant() implementation end-to-end, simulating only the raw
      // Supabase response its insert() call would get back from Postgres
      // when the admin_principals_single_active_master_admin_idx partial
      // unique index rejects a concurrent loser's row. This is what
      // demonstrates the full chain now actually works after the
      // repository fix (grant() propagating write errors), not just that
      // the bootstrap-service mapping logic works when handed an error.
      const uniqueViolation = new Error(
        'duplicate key value violates unique constraint "admin_principals_single_active_master_admin_idx"'
      );
      uniqueViolation.code = '23505';

      mock = {
        from() {
          return {
            select(cols) {
              // hasActiveMasterAdmin(): select('uid').eq(role).eq(status).limit(1)
              if (cols === 'uid') {
                return {
                  eq() {
                    return {
                      eq() {
                        return { limit: () => Promise.resolve({ data: [], error: null }) };
                      },
                    };
                  },
                };
              }
              // getPrincipal(): select('*').eq('uid', uid).maybeSingle()
              return {
                eq() {
                  return { maybeSingle: () => Promise.resolve({ data: null, error: null }) };
                },
              };
            },
            insert() {
              // Simulates the concurrency loser's write being rejected by
              // the DB-level partial unique index.
              return Promise.resolve({ data: null, error: uniqueViolation });
            },
          };
        },
      };

      await expect(bootstrapMasterAdmin({ uid: 'racer-b-real-grant' })).rejects.toBeInstanceOf(
        BootstrapAlreadyCompletedError
      );

      const actions = logAdminAction.mock.calls.map(([event]) => event.action);
      expect(actions).not.toContain('ADMIN_BOOTSTRAPPED');
    });

    it('does not swallow a DB error that is not a unique_violation', async () => {
      const otherError = new Error('connection terminated unexpectedly');
      otherError.code = '57P01';

      jest.spyOn(repo, 'grant').mockRejectedValueOnce(otherError);

      await expect(bootstrapMasterAdmin({ uid: 'new-admin-uid' })).rejects.toThrow(
        'connection terminated unexpectedly'
      );
    });
  });

  describe('authority synchronization (WP-ADMIN-IMP-07 §10/§12)', () => {
    it('reports a failed Auth app_metadata sync explicitly without failing the bootstrap', async () => {
      syncAdminRoleToAuth.mockResolvedValueOnce({
        synchronized: false,
        error: 'No Supabase Auth user found for uid new-admin-uid',
      });

      const result = await bootstrapMasterAdmin({ uid: 'new-admin-uid' });

      // DB authority is still established — bootstrap itself succeeds.
      expect(result.success).toBe(true);
      expect(result.authSynchronized).toBe(false);
      expect(result.authSyncError).toBe('No Supabase Auth user found for uid new-admin-uid');

      const row = await repo.getPrincipal('new-admin-uid');
      expect(row).toMatchObject({ role: 'MASTER_ADMIN', status: STATES.ACTIVE });
    });

    it('records an ADMIN_AUTH_SYNC_FAILED audit event when sync fails, distinct from ADMIN_BOOTSTRAPPED', async () => {
      syncAdminRoleToAuth.mockResolvedValueOnce({ synchronized: false, error: 'network error' });

      await bootstrapMasterAdmin({ uid: 'new-admin-uid' });

      const actions = logAdminAction.mock.calls.map(([event]) => event.action);
      expect(actions).toContain('ADMIN_BOOTSTRAPPED');
      expect(actions).toContain('ADMIN_AUTH_SYNC_FAILED');
    });

    it('does not record ADMIN_AUTH_SYNC_FAILED when sync succeeds', async () => {
      await bootstrapMasterAdmin({ uid: 'new-admin-uid' });

      const actions = logAdminAction.mock.calls.map(([event]) => event.action);
      expect(actions).not.toContain('ADMIN_AUTH_SYNC_FAILED');
    });
  });
});
