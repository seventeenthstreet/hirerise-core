'use strict';

/**
 * src/modules/onboarding/__tests__/onboarding.careerReport.canonicalFallback.test.js
 *
 * WP-PRO-12B — Career Report Data Source Reconciliation.
 *
 * Exercises generateCareerReport()'s education/experience validation only.
 * The AI generation step itself is not under test here (getAnthropicClient()
 * returns null under NODE_ENV=test, so a successful validation pass
 * deliberately surfaces as the pre-existing "AI generation failed" 502 —
 * that is how we assert the code got past the education/experience check
 * without needing to mock the Anthropic SDK).
 *
 * getProfessionalProfile() is mocked at the module boundary, matching the
 * existing convention in onboarding.helpers.completionSync.test.js.
 */

function makeSupabaseFrom(tables) {
  return function from(table) {
    const filters = [];
    const api = {
      select() {
        return api;
      },
      eq(field, value) {
        filters.push({ field, value });
        return api;
      },
      maybeSingle() {
        return (async () => {
          const rows = tables[table] || [];
          const row = rows.find((r) => filters.every((f) => r[f.field] === f.value)) || null;
          return { data: row, error: null };
        })();
      },
    };
    return api;
  };
}

jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../../../infrastructure/aiLogger', () => ({
  logAIInteraction: jest.fn(),
}));

jest.mock('../../../domain/professionalProfile/professionalProfile.repository', () => ({
  getProfessionalProfile: jest.fn(),
}));

jest.mock('../onboarding.helpers', () => ({
  MODEL: 'test-model',
  callAnthropicWithRetry: jest.fn(),
  stripJson: jest.fn((s) => s),
  checkIdempotencyKey: jest.fn().mockResolvedValue(null),
  saveIdempotencyKey: jest.fn(),
  deductCredits: jest.fn(),
  emitOnboardingEvent: jest.fn(),
  mergeStepHistory: jest.fn().mockResolvedValue([]),
  buildAIContext: jest.fn().mockReturnValue({ userRegion: 'India' }),
  triggerProvisionalChi: jest.fn(),
  persistCompletionIfReady: jest.fn(),
}));

const mockFrom = jest.fn();

jest.doMock('../../../config/supabase', () => ({
  supabase: { from: (...args) => mockFrom(...args) },
}));

const USER_ID = 'user-1';

const PROFILE_ROW_WITH_ROLE = {
  id: USER_ID,
  expected_role_ids: ['role-1'],
  target_role: null,
  current_city: 'Bengaluru',
  skills: [],
};

describe('generateCareerReport — WP-PRO-12B canonical Professional Profile fallback', () => {
  let generateCareerReport;
  let getProfessionalProfile;

  beforeEach(() => {
    jest.clearAllMocks();
    ({ generateCareerReport } = require('../onboarding.careerReport.service'));
    ({ getProfessionalProfile } = require('../../../domain/professionalProfile/professionalProfile.repository'));
  });

  it('throws the existing 422 when neither onboarding_progress nor the canonical profile has data', async () => {
    mockFrom.mockImplementation(makeSupabaseFrom({
      onboarding_progress: [{ id: USER_ID, education: [], experience: [] }],
      user_profiles: [PROFILE_ROW_WITH_ROLE],
    }));
    getProfessionalProfile.mockResolvedValue({ education: [], experience: [] });

    await expect(generateCareerReport(USER_ID, 0)).rejects.toMatchObject({
      message: 'Add education or experience first',
      statusCode: 422,
    });
  });

  it('falls back to the canonical Professional Profile when onboarding_progress is empty, and gets past validation', async () => {
    mockFrom.mockImplementation(makeSupabaseFrom({
      onboarding_progress: [{ id: USER_ID, education: [], experience: [] }],
      user_profiles: [PROFILE_ROW_WITH_ROLE],
    }));
    getProfessionalProfile.mockResolvedValue({
      education: [{ institution: 'MIT' }],
      experience: [],
    });

    // Validation passes (fallback found data) → execution proceeds past both
    // 422 checks and fails later at the (unmocked, test-env) AI call step —
    // proof the education/experience gate was satisfied by the fallback.
    await expect(generateCareerReport(USER_ID, 0)).rejects.toMatchObject({
      message: 'AI generation failed',
      statusCode: 502,
    });
    expect(getProfessionalProfile).toHaveBeenCalledWith(USER_ID);
  });

  it('does not consult the fallback when onboarding_progress already has synchronized data', async () => {
    mockFrom.mockImplementation(makeSupabaseFrom({
      onboarding_progress: [{
        id: USER_ID,
        education: [{ institution: 'Existing University' }],
        experience: [{ company: 'Existing Co' }],
      }],
      user_profiles: [PROFILE_ROW_WITH_ROLE],
    }));

    await expect(generateCareerReport(USER_ID, 0)).rejects.toMatchObject({
      message: 'AI generation failed',
      statusCode: 502,
    });
    expect(getProfessionalProfile).not.toHaveBeenCalled();
  });
});
