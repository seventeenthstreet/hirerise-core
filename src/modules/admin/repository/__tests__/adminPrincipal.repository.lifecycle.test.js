'use strict';

const { createAdminPrincipalsSupabaseMock } = require('../testHelpers/adminPrincipalsSupabaseMock');

let mock;

jest.mock('../../../../config/supabase', () => ({
  get supabase() {
    return mock;
  },
}));

const { STATES, InvalidLifecycleTransitionError } = require('../../../../domain/admin/lifecycle/adminLifecycle.states');
// Required once, after the mock above is in place, so this repository
// instance and the InvalidLifecycleTransitionError class imported above
// resolve from the same (non-reset) module registry entry.
const repo = require('../adminPrincipal.repository');

describe('adminPrincipal.repository — lifecycle', () => {
  const baseRow = (overrides = {}) => ({
    uid: 'admin-1',
    role: 'admin',
    status: STATES.ACTIVE,
    granted_by: 'system',
    granted_at: new Date().toISOString(),
    verified_at: new Date().toISOString(),
    last_action_at: new Date().toISOString(),
    is_active: true,
    ...overrides,
  });

  beforeEach(() => {
    mock = createAdminPrincipalsSupabaseMock([baseRow()]);
  });

  describe('getSupabase() bugfix', () => {
    it('reaches the Supabase client (no "supabase.from is not a function")', async () => {
      await expect(repo.getPrincipal('admin-1')).resolves.toMatchObject({ uid: 'admin-1' });
    });
  });

  describe('suspend / reactivate', () => {
    it('suspends an active principal', async () => {
      await repo.suspend('admin-1', 'master-1', 'policy violation');
      const row = await repo.getPrincipal('admin-1');
      expect(row.status).toBe(STATES.SUSPENDED);
      expect(row.suspended_by).toBe('master-1');
      expect(row.suspension_reason).toBe('policy violation');
    });

    it('reactivates a suspended principal', async () => {
      await repo.suspend('admin-1', 'master-1');
      await repo.reactivate('admin-1', 'master-1');
      const row = await repo.getPrincipal('admin-1');
      expect(row.status).toBe(STATES.ACTIVE);
      expect(row.reactivated_by).toBe('master-1');
    });

    it('rejects suspending an already-suspended principal', async () => {
      await repo.suspend('admin-1', 'master-1');
      await expect(repo.suspend('admin-1', 'master-1')).rejects.toBeInstanceOf(
        InvalidLifecycleTransitionError
      );
    });

    it('rejects reactivating an active principal', async () => {
      await expect(repo.reactivate('admin-1', 'master-1')).rejects.toBeInstanceOf(
        InvalidLifecycleTransitionError
      );
    });

    it('rejects lifecycle actions on an unknown uid', async () => {
      await expect(repo.suspend('ghost', 'master-1')).rejects.toBeInstanceOf(
        InvalidLifecycleTransitionError
      );
    });
  });

  describe('revoke', () => {
    it('revokes an active principal (terminal)', async () => {
      await repo.revoke('admin-1', 'master-1');
      const row = await repo.getPrincipal('admin-1');
      expect(row.status).toBe(STATES.REVOKED);
      expect(row.revoked_by).toBe('master-1');
    });

    it('revokes a suspended principal', async () => {
      await repo.suspend('admin-1', 'master-1');
      await repo.revoke('admin-1', 'master-1');
      const row = await repo.getPrincipal('admin-1');
      expect(row.status).toBe(STATES.REVOKED);
    });

    it('rejects revoking an already-revoked principal', async () => {
      await repo.revoke('admin-1', 'master-1');
      await expect(repo.revoke('admin-1', 'master-1')).rejects.toBeInstanceOf(
        InvalidLifecycleTransitionError
      );
    });
  });

  describe('grant', () => {
    it('re-activates a revoked principal', async () => {
      await repo.revoke('admin-1', 'master-1');
      await repo.grant('admin-1', 'admin', 'master-1');
      const row = await repo.getPrincipal('admin-1');
      expect(row.status).toBe(STATES.ACTIVE);
      expect(row.revoked_at).toBeNull();
    });

    it('creates a new principal when none exists', async () => {
      await repo.grant('admin-2', 'admin', 'master-1');
      const row = await repo.getPrincipal('admin-2');
      expect(row.status).toBe(STATES.ACTIVE);
    });
  });

  describe('verify — lifecycle enforcement', () => {
    it('passes for an active, fresh principal', async () => {
      await expect(repo.verify('admin-1')).resolves.toMatchObject({ uid: 'admin-1' });
    });

    it('fails for a suspended principal', async () => {
      await repo.suspend('admin-1', 'master-1');
      await expect(repo.verify('admin-1')).resolves.toBeNull();
    });

    it('fails for a revoked principal', async () => {
      await repo.revoke('admin-1', 'master-1');
      await expect(repo.verify('admin-1')).resolves.toBeNull();
    });

    it('fails and lazily transitions to expired once expires_at has passed', async () => {
      mock.__setRows([
        baseRow({ expires_at: new Date(Date.now() - 1000).toISOString() }),
      ]);
      await expect(repo.verify('admin-1')).resolves.toBeNull();
      const row = await repo.getPrincipal('admin-1');
      expect(row.status).toBe(STATES.EXPIRED);
    });

    it('still enforces the 24h session TTL for active non-MASTER_ADMIN principals (regression)', async () => {
      mock.__setRows([
        baseRow({ verified_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() }),
      ]);
      await expect(repo.verify('admin-1')).resolves.toBeNull();
    });

    it('MASTER_ADMIN bypasses TTL but not lifecycle status (regression)', async () => {
      mock.__setRows([
        baseRow({
          role: 'MASTER_ADMIN',
          verified_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        }),
      ]);
      await expect(repo.verify('admin-1')).resolves.toMatchObject({ uid: 'admin-1' });

      await repo.suspend('admin-1', 'someone');
      await expect(repo.verify('admin-1')).resolves.toBeNull();
    });
  });

  describe('listActive / listByStatus', () => {
    it('only lists principals with status=active', async () => {
      mock.__setRows([
        baseRow({ uid: 'a', status: STATES.ACTIVE }),
        baseRow({ uid: 'b', status: STATES.SUSPENDED }),
        baseRow({ uid: 'c', status: STATES.REVOKED }),
      ]);
      const active = await repo.listActive();
      expect(active.map((r) => r.uid)).toEqual(['a']);
    });
  });
});
