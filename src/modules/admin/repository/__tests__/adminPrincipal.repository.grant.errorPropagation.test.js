'use strict';

/**
 * WP-ADMIN-IMP-07 follow-up — focused regression coverage for the
 * grant()-error-propagation fix.
 *
 * Scope: only proves that a Supabase write error from either write path
 * inside grant() (insert for a brand-new uid, update for an existing row)
 * reaches the caller unchanged — same object, same .code — rather than
 * being silently swallowed. Does not exercise any other lifecycle method.
 */

let mock;

jest.mock('../../../../config/supabase', () => ({
  get supabase() {
    return mock;
  },
}));

const { STATES } = require('../../../../domain/admin/lifecycle/adminLifecycle.states');
const repo = require('../adminPrincipal.repository');

// Minimal Supabase query-builder stub. Only implements what grant() calls
// on its two write paths (insert / update) plus the select().eq() shape
// getPrincipal() needs to determine whether a row already exists.
function createWriteErrorMock({ existingRow = null, insertError = null, updateError = null }) {
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: () => Promise.resolve({ data: existingRow, error: null }),
                single: () => Promise.resolve({ data: existingRow, error: null }),
              };
            },
          };
        },
        insert() {
          return Promise.resolve({ data: insertError ? null : {}, error: insertError });
        },
        update() {
          return {
            eq: () => Promise.resolve({ data: updateError ? null : {}, error: updateError }),
          };
        },
      };
    },
  };
}

describe('adminPrincipal.repository#grant — write-error propagation (WP-ADMIN-IMP-07 follow-up)', () => {
  describe('insert path (no existing row for this uid)', () => {
    it('propagates a Postgres 23505 unique_violation from insert() unchanged', async () => {
      const uniqueViolation = new Error(
        'duplicate key value violates unique constraint "admin_principals_single_active_master_admin_idx"'
      );
      uniqueViolation.code = '23505';

      mock = createWriteErrorMock({ existingRow: null, insertError: uniqueViolation });

      await expect(
        repo.grant('racer-uid', 'MASTER_ADMIN', 'system:bootstrap')
      ).rejects.toBe(uniqueViolation);
    });

    it('propagates a non-unique-violation insert error unchanged too', async () => {
      const connectionError = new Error('connection terminated unexpectedly');
      connectionError.code = '57P01';

      mock = createWriteErrorMock({ existingRow: null, insertError: connectionError });

      await expect(
        repo.grant('some-uid', 'admin', 'granter')
      ).rejects.toBe(connectionError);
    });

    it('still succeeds normally when insert() reports no error', async () => {
      mock = createWriteErrorMock({ existingRow: null, insertError: null });

      await expect(repo.grant('clean-uid', 'admin', 'granter')).resolves.toBeUndefined();
    });
  });

  describe('update path (existing row for this uid)', () => {
    const existingRow = () => ({
      uid: 'existing-uid',
      role: 'admin',
      status: STATES.REVOKED,
      granted_by: 'someone',
      granted_at: new Date().toISOString(),
    });

    it('propagates a Supabase error from update() unchanged', async () => {
      const updateError = new Error('row-level security policy violation');
      updateError.code = '42501';

      mock = createWriteErrorMock({ existingRow: existingRow(), updateError });

      await expect(
        repo.grant('existing-uid', 'MASTER_ADMIN', 'system:bootstrap')
      ).rejects.toBe(updateError);
    });

    it('still succeeds normally when update() reports no error', async () => {
      mock = createWriteErrorMock({ existingRow: existingRow(), updateError: null });

      await expect(
        repo.grant('existing-uid', 'MASTER_ADMIN', 'system:bootstrap')
      ).resolves.toBeUndefined();
    });
  });
});
