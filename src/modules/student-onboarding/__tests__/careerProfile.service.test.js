'use strict';

/**
 * modules/student-onboarding/__tests__/careerProfile.service.test.js
 *
 * Exercises the real code path against an in-memory Supabase fake — same
 * pattern as studentIntelligence.repository.test.js.
 */

const { createSupabaseMock } = require('../../knowledge-runtime/knowledge/testHelpers/supabaseMock');

jest.mock('../../../config/supabase', () => ({
  supabase: global.__careerProfileSupabaseMock,
}));

jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

describe('careerProfile.service', () => {
  let getCareerProfile;
  let CareerProfileServiceError;

  const row = {
    user_id: 'user-1',
    interests: ['technology', 'design'],
    career_curiosities: ['software engineer'],
  };

  beforeEach(() => {
    jest.resetModules();

    global.__careerProfileSupabaseMock = createSupabaseMock({
      student_career_profiles: [row],
    });

    ({ getCareerProfile, CareerProfileServiceError } = require('../services/careerProfile.service'));
  });

  it('returns interests and career_curiosities for an existing profile', async () => {
    const result = await getCareerProfile('user-1');

    expect(result).toEqual({
      interests: ['technology', 'design'],
      careerCuriosities: ['software engineer'],
    });
  });

  it('returns null when no profile row exists for the user', async () => {
    const result = await getCareerProfile('no-such-user');
    expect(result).toBeNull();
  });

  it('returns null when userId is falsy, without querying', async () => {
    const result = await getCareerProfile(null);
    expect(result).toBeNull();
  });

  it('defaults missing array columns to empty arrays', async () => {
    global.__careerProfileSupabaseMock = createSupabaseMock({
      student_career_profiles: [{ user_id: 'user-2', interests: null, career_curiosities: null }],
    });
    jest.resetModules();
    ({ getCareerProfile } = require('../services/careerProfile.service'));

    const result = await getCareerProfile('user-2');
    expect(result).toEqual({ interests: [], careerCuriosities: [] });
  });

  it('throws CareerProfileServiceError when the query fails', async () => {
    global.__careerProfileSupabaseMock = createSupabaseMock({
      student_career_profiles: [row],
    });
    global.__careerProfileSupabaseMock.from = () => ({
      select() {
        return this;
      },
      eq() {
        return this;
      },
      maybeSingle: async () => ({ data: null, error: { message: 'boom' } }),
    });
    jest.resetModules();
    ({ getCareerProfile, CareerProfileServiceError } = require('../services/careerProfile.service'));

    await expect(getCareerProfile('user-1')).rejects.toThrow(CareerProfileServiceError);
  });
});
