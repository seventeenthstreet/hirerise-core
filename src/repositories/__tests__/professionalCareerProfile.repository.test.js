'use strict';

/**
 * repositories/__tests__/professionalCareerProfile.repository.test.js
 *
 * Exercises the real code path against an in-memory Supabase fake — same
 * pattern as studentIntelligence.repository.test.js.
 */

const { createSupabaseMock } = require('../../modules/knowledge-runtime/knowledge/testHelpers/supabaseMock');

jest.mock('../../config/supabase', () => ({
  supabase: global.__professionalCareerProfileSupabaseMock,
}));

jest.mock('../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

describe('professionalCareerProfile.repository', () => {
  let getProfessionalCareerProfile;

  beforeEach(() => {
    jest.resetModules();

    global.__professionalCareerProfileSupabaseMock = createSupabaseMock({
      users: [{ id: 'user-1', career_goal: 'Become a senior engineer' }],
      user_profiles: [
        { user_id: 'user-1', data: { career_goals: ['switch to product management'] } },
      ],
    });

    ({ getProfessionalCareerProfile } = require('../professionalCareerProfile.repository'));
  });

  it('combines users.career_goal and user_profiles.data.career_goals', async () => {
    const result = await getProfessionalCareerProfile('user-1');

    expect(result).toEqual({
      careerGoal: 'Become a senior engineer',
      careerGoals: ['switch to product management'],
    });
  });

  it('returns null when neither source has data for the user', async () => {
    const result = await getProfessionalCareerProfile('no-such-user');
    expect(result).toBeNull();
  });

  it('returns null when userId is falsy, without querying', async () => {
    const result = await getProfessionalCareerProfile(null);
    expect(result).toBeNull();
  });

  it('returns careerGoals as [] when user_profiles.data has no career_goals key', async () => {
    global.__professionalCareerProfileSupabaseMock = createSupabaseMock({
      users: [{ id: 'user-2', career_goal: 'Move into data science' }],
      user_profiles: [{ user_id: 'user-2', data: {} }],
    });
    jest.resetModules();
    ({ getProfessionalCareerProfile } = require('../professionalCareerProfile.repository'));

    const result = await getProfessionalCareerProfile('user-2');
    expect(result).toEqual({ careerGoal: 'Move into data science', careerGoals: [] });
  });

  it('tolerates a query error on one source and still returns the other', async () => {
    global.__professionalCareerProfileSupabaseMock = createSupabaseMock({
      users: [{ id: 'user-3', career_goal: 'Lead a team' }],
      user_profiles: [],
    });
    const originalFrom = global.__professionalCareerProfileSupabaseMock.from.bind(
      global.__professionalCareerProfileSupabaseMock
    );
    global.__professionalCareerProfileSupabaseMock.from = (table) => {
      if (table === 'user_profiles') {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          maybeSingle: async () => ({ data: null, error: { message: 'boom' } }),
        };
      }
      return originalFrom(table);
    };
    jest.resetModules();
    ({ getProfessionalCareerProfile } = require('../professionalCareerProfile.repository'));

    const result = await getProfessionalCareerProfile('user-3');
    expect(result).toEqual({ careerGoal: 'Lead a team', careerGoals: [] });
  });
});
