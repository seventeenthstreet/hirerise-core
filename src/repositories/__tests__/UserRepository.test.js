'use strict';

/**
 * repositories/__tests__/UserRepository.test.js
 *
 * G2 (Phase 1) regression test — see UserRepository.js for the full
 * explanation. Uses the same shared in-memory Supabase fake as
 * professionalCareerProfile.repository.test.js.
 *
 * Bug #1: BaseRepository.update() filters `.eq('soft_deleted', false)`
 * unconditionally. The `users` table has no `soft_deleted` column, so
 * that filter can never match a real users row — updateProfile() silently
 * failed to persist anything (and, against the real Supabase client,
 * .single() with zero matching rows raises a DB error, so PATCH /me
 * failed outright). This test exercises the real
 * updateUser.service -> UserRepository -> BaseRepository code path (no
 * live DB), so it fails against the pre-fix implementation and passes
 * against the override in UserRepository.js.
 *
 * Bug #2 (found via live verification after Bug #1's fix landed):
 * BaseRepository.update()'s `userId = 'system'` default is written into
 * `updated_by`, which is `uuid`-typed on `users` — writing the literal
 * string 'system' into it fails in a real Postgres DB with an invalid
 * uuid syntax error. This in-memory mock does NOT validate column types
 * (it's a plain JS object store), so it cannot reproduce that failure —
 * the assertion below only confirms the CORRECT VALUE is now passed
 * (the acting user's own id), not that Postgres would accept it. That
 * distinction matters: this test alone would not have caught Bug #2
 * before it was found live; the type-level guarantee only comes from a
 * real database.
 */

const { createSupabaseMock } = require('../../modules/knowledge-runtime/knowledge/testHelpers/supabaseMock');

jest.mock('../../config/supabase', () => ({
  supabase: global.__userRepositorySupabaseMock,
}));

describe('UserRepository.updateProfile (G2 write path)', () => {
  let userRepository;

  beforeEach(() => {
    jest.resetModules();

    global.__userRepositorySupabaseMock = createSupabaseMock({
      users: [
        {
          id: 'user-1',
          email: 'student@example.com',
          display_name: null,
          user_type: 'student',
        },
      ],
    });

    userRepository = require('../UserRepository');
  });

  it('persists a name update to display_name despite the table having no soft_deleted column', async () => {
    const updated = await userRepository.updateProfile('user-1', { name: 'Asha' });

    // Would be null before the fix — the soft_deleted filter matched
    // nothing on a users row, so BaseRepository.update()'s .single() call
    // returned no row for updateProfile() to return.
    expect(updated).not.toBeNull();
    expect(updated.displayName).toBe('Asha');
  });

  it('writes to the display_name column (not a camelCase displayName column)', async () => {
    await userRepository.updateProfile('user-1', { name: 'Asha' });

    const row = global.__userRepositorySupabaseMock.from('users')._rows.find((r) => r.id === 'user-1');
    expect(row.display_name).toBe('Asha');
    expect(row.displayName).toBeUndefined();
  });

  it('rejects protected fields (e.g. role) even after the override', async () => {
    await expect(userRepository.updateProfile('user-1', { role: 'admin' })).rejects.toThrow(
      'No valid fields provided for update.',
    );
  });

  it('sets updated_by to the acting user\'s own id, not the "system" string default (Bug #2)', async () => {
    await userRepository.updateProfile('user-1', { name: 'Asha' });

    const row = global.__userRepositorySupabaseMock.from('users')._rows.find((r) => r.id === 'user-1');
    expect(row.updated_by).toBe('user-1');
    expect(row.updated_by).not.toBe('system');
  });
});
