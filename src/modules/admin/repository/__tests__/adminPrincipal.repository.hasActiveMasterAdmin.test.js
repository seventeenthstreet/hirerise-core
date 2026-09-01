'use strict';

const { createAdminPrincipalsSupabaseMock } = require('../testHelpers/adminPrincipalsSupabaseMock');

let mock;

jest.mock('../../../../config/supabase', () => ({
  get supabase() {
    return mock;
  },
}));

const { STATES } = require('../../../../domain/admin/lifecycle/adminLifecycle.states');
const repo = require('../adminPrincipal.repository');

const row = (overrides = {}) => ({
  uid: 'some-uid',
  role: 'admin',
  status: STATES.ACTIVE,
  granted_by: 'system',
  granted_at: new Date().toISOString(),
  ...overrides,
});

describe('adminPrincipal.repository#hasActiveMasterAdmin (WP-ADMIN-IMP-07)', () => {
  it('returns false when no rows exist at all', async () => {
    mock = createAdminPrincipalsSupabaseMock([]);
    await expect(repo.hasActiveMasterAdmin()).resolves.toBe(false);
  });

  it('returns false when only non-MASTER_ADMIN active principals exist', async () => {
    mock = createAdminPrincipalsSupabaseMock([
      row({ uid: 'admin-1', role: 'admin', status: STATES.ACTIVE }),
      row({ uid: 'admin-2', role: 'super_admin', status: STATES.ACTIVE }),
    ]);
    await expect(repo.hasActiveMasterAdmin()).resolves.toBe(false);
  });

  it('returns false when a MASTER_ADMIN row exists but is not active', async () => {
    mock = createAdminPrincipalsSupabaseMock([
      row({ uid: 'former-master', role: 'MASTER_ADMIN', status: STATES.REVOKED }),
    ]);
    await expect(repo.hasActiveMasterAdmin()).resolves.toBe(false);
  });

  it('returns true when an active MASTER_ADMIN row exists', async () => {
    mock = createAdminPrincipalsSupabaseMock([
      row({ uid: 'admin-1', role: 'admin', status: STATES.ACTIVE }),
      row({ uid: 'master-1', role: 'MASTER_ADMIN', status: STATES.ACTIVE }),
    ]);
    await expect(repo.hasActiveMasterAdmin()).resolves.toBe(true);
  });

  it('fails closed: propagates the original Supabase/DB error unchanged (does not silently return false, does not wrap/lose it)', async () => {
    const dbError = new Error('connection reset');
    dbError.code = '57P01'; // e.g. a real Postgres error code the caller might inspect

    mock = {
      from() {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          limit() {
            return Promise.resolve({ data: null, error: dbError });
          },
        };
      },
    };

    await expect(repo.hasActiveMasterAdmin()).rejects.toBe(dbError);
  });
});
