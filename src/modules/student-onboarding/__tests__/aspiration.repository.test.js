'use strict';

/**
 * modules/student-onboarding/__tests__/aspiration.repository.test.js
 *
 * The shared supabaseMock helper (knowledge-runtime/knowledge/testHelpers/
 * supabaseMock.js) does not implement .upsert() (see its own docblock —
 * scoped to what BaseRepository's findById/find exercise). Rather than
 * extend that shared fake for a single call this module needs, this file
 * uses a small local chainable mock scoped to exactly the calls
 * aspiration.repository.js makes — .from().upsert().select().single() and
 * .from().select().eq().maybeSingle().
 */

const { upsertAspiration, fetchAspiration } = require('../repositories/aspiration.repository');

function buildSupabaseMock({ upsertResult, upsertError, selectResult, selectError } = {}) {
  const upsertChain = {
    select: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data: upsertResult ?? null, error: upsertError ?? null }),
  };

  const selectChain = {
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: selectResult ?? null, error: selectError ?? null }),
  };

  const from = jest.fn((table) => ({
    upsert: jest.fn().mockReturnValue(upsertChain),
    select: jest.fn().mockReturnValue(selectChain),
    __table: table,
  }));

  return { from, __upsertChain: upsertChain, __selectChain: selectChain };
}

describe('aspiration.repository', () => {
  describe('upsertAspiration', () => {
    it('calls student_aspirations.upsert with the given payload and onConflict user_id', async () => {
      const persistedRow = {
        user_id: 'user-1',
        career_interests: ['engineering'],
        motivation_driver: 'impact',
        time_horizon: 'medium',
      };
      const supabase = buildSupabaseMock({ upsertResult: persistedRow });

      const result = await upsertAspiration(supabase, {
        user_id: 'user-1',
        career_interests: ['engineering'],
        motivation_driver: 'impact',
        time_horizon: 'medium',
      });

      expect(supabase.from).toHaveBeenCalledWith('student_aspirations');
      const fromCallResult = supabase.from.mock.results[0].value;
      expect(fromCallResult.upsert).toHaveBeenCalledWith(
        {
          user_id: 'user-1',
          career_interests: ['engineering'],
          motivation_driver: 'impact',
          time_horizon: 'medium',
        },
        { onConflict: 'user_id', ignoreDuplicates: false },
      );
      expect(result).toEqual(persistedRow);
    });

    it('throws when supabase returns an error', async () => {
      const supabase = buildSupabaseMock({ upsertError: new Error('constraint violation') });

      await expect(
        upsertAspiration(supabase, {
          user_id: 'user-1',
          career_interests: [],
          motivation_driver: null,
          time_horizon: null,
        }),
      ).rejects.toThrow('constraint violation');
    });
  });

  describe('fetchAspiration', () => {
    it('returns the row filtered by user_id', async () => {
      const row = {
        user_id: 'user-1',
        career_interests: ['medicine'],
        motivation_driver: null,
        time_horizon: null,
      };
      const supabase = buildSupabaseMock({ selectResult: row });

      const result = await fetchAspiration(supabase, 'user-1');

      const fromCallResult = supabase.from.mock.results[0].value;
      expect(supabase.from).toHaveBeenCalledWith('student_aspirations');
      expect(fromCallResult.select().eq).toHaveBeenCalledWith('user_id', 'user-1');
      expect(result).toEqual(row);
    });

    it('returns null when no row exists', async () => {
      const supabase = buildSupabaseMock({ selectResult: null });
      const result = await fetchAspiration(supabase, 'user-with-no-aspiration');
      expect(result).toBeNull();
    });

    it('throws when supabase returns an error', async () => {
      const supabase = buildSupabaseMock({ selectError: new Error('connection refused') });
      await expect(fetchAspiration(supabase, 'user-1')).rejects.toThrow('connection refused');
    });
  });
});
