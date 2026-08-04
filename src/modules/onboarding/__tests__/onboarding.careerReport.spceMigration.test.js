'use strict';

/**
 * @file src/modules/onboarding/__tests__/onboarding.careerReport.spceMigration.test.js
 *
 * WP-SPCE-03A — Career Report Migration — regression tests.
 *
 * Exercises generateCareerReport() end-to-end (mocking at the same module
 * boundaries as onboarding.careerReport.canonicalFallback.test.js) to
 * confirm the migrated readiness gate — now backed by
 * readinessEngine.evaluate('career_report', ...) instead of two manual
 * `if` checks — preserves every externally observable behavior:
 *
 *   - the exact same two 422 messages, in the exact same precedence order
 *   - the exact same 404/400/502 behavior for everything untouched by
 *     this migration
 *   - the exact same side-effect ordering: role resolution
 *     (resolveExpectedRoleIdsFromTitle + its DB write) must NOT run when
 *     the education/experience gate fails, exactly as before migration
 *   - a successful case that clears both gates and reaches the (mocked)
 *     AI call, proving SPCE actually ran and didn't just always fail open
 *     or always fail closed
 */

function makeSupabaseFrom(tables) {
  return function from(table) {
    const filters = [];
    const updates = [];
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
      update(patch) {
        updates.push(patch);
        return api;
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

jest.mock('../../../shared/utils/roleCatalog', () => ({
  resolveExpectedRoleIdsFromTitle: jest.fn(),
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

describe('generateCareerReport — WP-SPCE-03A SPCE-backed readiness gate', () => {
  let generateCareerReport;
  let getProfessionalProfile;
  let resolveExpectedRoleIdsFromTitle;

  beforeEach(() => {
    jest.clearAllMocks();
    ({ generateCareerReport } = require('../onboarding.careerReport.service'));
    ({ getProfessionalProfile } = require('../../../domain/professionalProfile/professionalProfile.repository'));
    ({ resolveExpectedRoleIdsFromTitle } = require('../../../shared/utils/roleCatalog'));
    getProfessionalProfile.mockResolvedValue({ education: [], experience: [] });
  });

  it('throws "Add education or experience first" / 422 when both are empty, same as pre-migration', async () => {
    mockFrom.mockImplementation(makeSupabaseFrom({
      onboarding_progress: [{ id: USER_ID, education: [], experience: [] }],
      user_profiles: [{ id: USER_ID, expected_role_ids: ['role-1'], target_role: null }],
    }));

    await expect(generateCareerReport(USER_ID, 0)).rejects.toMatchObject({
      message: 'Add education or experience first',
      statusCode: 422,
    });
  });

  it('does NOT run role resolution when education/experience readiness fails (side-effect ordering preserved)', async () => {
    mockFrom.mockImplementation(makeSupabaseFrom({
      onboarding_progress: [{ id: USER_ID, education: [], experience: [] }],
      // expected_role_ids empty + target_role set would normally trigger
      // resolveExpectedRoleIdsFromTitle() — it must NOT fire here, since
      // the pre-migration code never reached that block when the
      // education/experience gate failed first.
      user_profiles: [{ id: USER_ID, expected_role_ids: [], target_role: 'Software Engineer' }],
    }));

    await expect(generateCareerReport(USER_ID, 0)).rejects.toMatchObject({
      message: 'Add education or experience first',
      statusCode: 422,
    });

    expect(resolveExpectedRoleIdsFromTitle).not.toHaveBeenCalled();
  });

  it('throws "Target role required" / 422 when education/experience pass but role is missing', async () => {
    mockFrom.mockImplementation(makeSupabaseFrom({
      onboarding_progress: [{ id: USER_ID, education: [{ institution: 'MIT' }], experience: [] }],
      user_profiles: [{ id: USER_ID, expected_role_ids: [], target_role: null }],
    }));

    await expect(generateCareerReport(USER_ID, 0)).rejects.toMatchObject({
      message: 'Target role required',
      statusCode: 422,
    });
  });

  it('still resolves target_role -> expected_role_ids on the read path, and proceeds when resolution succeeds', async () => {
    resolveExpectedRoleIdsFromTitle.mockResolvedValue(['resolved-role-1']);
    mockFrom.mockImplementation(makeSupabaseFrom({
      onboarding_progress: [{ id: USER_ID, education: [{ institution: 'MIT' }], experience: [] }],
      user_profiles: [{ id: USER_ID, expected_role_ids: [], target_role: 'Software Engineer' }],
    }));

    // Validation now passes via the resolved role -> proceeds to the
    // (unmocked in test env) AI call and fails there, same signal
    // onboarding.careerReport.canonicalFallback.test.js already relies on.
    await expect(generateCareerReport(USER_ID, 0)).rejects.toMatchObject({
      message: 'AI generation failed',
      statusCode: 502,
    });
    expect(resolveExpectedRoleIdsFromTitle).toHaveBeenCalledWith('Software Engineer');
  });

  it('WP-PRO-12E: proceeds using the free-text title when target_role fails to resolve against the catalog (no longer 422s)', async () => {
    resolveExpectedRoleIdsFromTitle.mockResolvedValue([]);
    mockFrom.mockImplementation(makeSupabaseFrom({
      onboarding_progress: [{ id: USER_ID, education: [{ institution: 'MIT' }], experience: [] }],
      user_profiles: [{ id: USER_ID, expected_role_ids: [], target_role: 'General Manager' }],
    }));

    // A catalog miss is no longer fatal — "General Manager" isn't in a
    // 5-row test-tech-roles catalog, but the user DID tell us their target
    // role, so generation proceeds (using the free-text name in the AI
    // prompt) and fails only at the (unmocked in test env) AI call, same
    // signal every other "proceeds" test in this file relies on.
    await expect(generateCareerReport(USER_ID, 0)).rejects.toMatchObject({
      message: 'AI generation failed',
      statusCode: 502,
    });
    expect(resolveExpectedRoleIdsFromTitle).toHaveBeenCalledWith('General Manager');
  });

  // WP-PRO-12C — regression coverage for the bugfix: Resume-Upload-only
  // users never have `target_role` set (professionalProfile.normalizer
  // .js#normalizeResumeUpload doesn't write careerGoals), so the pre-fix
  // self-heal never ran for them and Career Report always 422'd with
  // "Target role required" even though onboarding was marked complete.
  it('BUGFIX: falls back to current_job_title when target_role is null (CV-only onboarding, resolution succeeds)', async () => {
    resolveExpectedRoleIdsFromTitle.mockResolvedValue(['resolved-role-1']);
    mockFrom.mockImplementation(makeSupabaseFrom({
      onboarding_progress: [{ id: USER_ID, education: [{ institution: 'MIT' }], experience: [] }],
      user_profiles: [{
        id: USER_ID,
        expected_role_ids: [],
        target_role: null,
        current_job_title: 'Senior Product Manager',
      }],
    }));

    await expect(generateCareerReport(USER_ID, 0)).rejects.toMatchObject({
      message: 'AI generation failed',
      statusCode: 502,
    });
    expect(resolveExpectedRoleIdsFromTitle).toHaveBeenCalledWith('Senior Product Manager');
  });

  it('WP-PRO-12E: proceeds on current_job_title alone even when catalog resolution fails for it (no longer 422s)', async () => {
    resolveExpectedRoleIdsFromTitle.mockResolvedValue([]);
    mockFrom.mockImplementation(makeSupabaseFrom({
      onboarding_progress: [{ id: USER_ID, education: [{ institution: 'MIT' }], experience: [] }],
      user_profiles: [{
        id: USER_ID,
        expected_role_ids: [],
        target_role: null,
        current_job_title: 'Some Unrecognized Title',
      }],
    }));

    await expect(generateCareerReport(USER_ID, 0)).rejects.toMatchObject({
      message: 'AI generation failed',
      statusCode: 502,
    });
    expect(resolveExpectedRoleIdsFromTitle).toHaveBeenCalledWith('Some Unrecognized Title');
  });

  it('BUGFIX: target_role still takes precedence over current_job_title when both are present', async () => {
    resolveExpectedRoleIdsFromTitle.mockResolvedValue(['resolved-role-1']);
    mockFrom.mockImplementation(makeSupabaseFrom({
      onboarding_progress: [{ id: USER_ID, education: [{ institution: 'MIT' }], experience: [] }],
      user_profiles: [{
        id: USER_ID,
        expected_role_ids: [],
        target_role: 'Software Engineer',
        current_job_title: 'Barista',
      }],
    }));

    await expect(generateCareerReport(USER_ID, 0)).rejects.toMatchObject({
      message: 'AI generation failed',
      statusCode: 502,
    });
    expect(resolveExpectedRoleIdsFromTitle).toHaveBeenCalledWith('Software Engineer');
  });

  it('BUGFIX: does not attempt role resolution when both target_role and current_job_title are absent', async () => {
    mockFrom.mockImplementation(makeSupabaseFrom({
      onboarding_progress: [{ id: USER_ID, education: [{ institution: 'MIT' }], experience: [] }],
      user_profiles: [{
        id: USER_ID,
        expected_role_ids: [],
        target_role: null,
        current_job_title: null,
      }],
    }));

    await expect(generateCareerReport(USER_ID, 0)).rejects.toMatchObject({
      message: 'Target role required',
      statusCode: 422,
    });
    expect(resolveExpectedRoleIdsFromTitle).not.toHaveBeenCalled();
  });

  it('BUGFIX (WP-PRO-12D): falls all the way back to the most recent experience entry\'s title when target_role and current_job_title are both null', async () => {
    resolveExpectedRoleIdsFromTitle.mockResolvedValue(['resolved-role-1']);
    mockFrom.mockImplementation(makeSupabaseFrom({
      onboarding_progress: [{
        id: USER_ID,
        education: [],
        experience: [{ company: 'Acme', title: 'Senior Backend Engineer' }],
      }],
      user_profiles: [{
        id: USER_ID,
        expected_role_ids: [],
        target_role: null,
        current_job_title: null,
      }],
    }));

    await expect(generateCareerReport(USER_ID, 0)).rejects.toMatchObject({
      message: 'AI generation failed',
      statusCode: 502,
    });
    expect(resolveExpectedRoleIdsFromTitle).toHaveBeenCalledWith('Senior Backend Engineer');
  });

  it('BUGFIX (WP-PRO-12D): tries current_job_title before falling back further to the experience title, and stops once one resolves', async () => {
    resolveExpectedRoleIdsFromTitle
      .mockResolvedValueOnce([]) // current_job_title fails
      .mockResolvedValueOnce(['resolved-role-1']); // experience title succeeds
    mockFrom.mockImplementation(makeSupabaseFrom({
      onboarding_progress: [{
        id: USER_ID,
        education: [],
        experience: [{ company: 'Acme', title: 'Senior Backend Engineer' }],
      }],
      user_profiles: [{
        id: USER_ID,
        expected_role_ids: [],
        target_role: null,
        current_job_title: 'Some Unrecognized Freelance Title',
      }],
    }));

    await expect(generateCareerReport(USER_ID, 0)).rejects.toMatchObject({
      message: 'AI generation failed',
      statusCode: 502,
    });
    expect(resolveExpectedRoleIdsFromTitle).toHaveBeenNthCalledWith(1, 'Some Unrecognized Freelance Title');
    expect(resolveExpectedRoleIdsFromTitle).toHaveBeenNthCalledWith(2, 'Senior Backend Engineer');
    expect(resolveExpectedRoleIdsFromTitle).toHaveBeenCalledTimes(2);
  });

  it('WP-PRO-12E: proceeds using the free-text experience title even when every catalog candidate fails to resolve (no longer 422s)', async () => {
    resolveExpectedRoleIdsFromTitle.mockResolvedValue([]);
    mockFrom.mockImplementation(makeSupabaseFrom({
      onboarding_progress: [{
        id: USER_ID,
        education: [],
        experience: [{ company: 'Acme', title: 'Freelance Chaos Coordinator' }],
      }],
      user_profiles: [{
        id: USER_ID,
        expected_role_ids: [],
        target_role: null,
        current_job_title: null,
      }],
    }));

    await expect(generateCareerReport(USER_ID, 0)).rejects.toMatchObject({
      message: 'AI generation failed',
      statusCode: 502,
    });
    expect(resolveExpectedRoleIdsFromTitle).toHaveBeenCalledWith('Freelance Chaos Coordinator');
  });

  it('WP-PRO-12E: still throws "Target role required" when there is truly no title anywhere (not even free-text)', async () => {
    mockFrom.mockImplementation(makeSupabaseFrom({
      onboarding_progress: [{
        id: USER_ID,
        education: [{ institution: 'MIT' }],
        experience: [{ company: 'Acme' }], // no `title` field on the entry
      }],
      user_profiles: [{
        id: USER_ID,
        expected_role_ids: [],
        target_role: null,
        current_job_title: null,
      }],
    }));

    await expect(generateCareerReport(USER_ID, 0)).rejects.toMatchObject({
      message: 'Target role required',
      statusCode: 422,
    });
    expect(resolveExpectedRoleIdsFromTitle).not.toHaveBeenCalled();
  });

  it('reaches AI generation (past both SPCE gates) when education, experience, and role are all present', async () => {
    mockFrom.mockImplementation(makeSupabaseFrom({
      onboarding_progress: [{
        id: USER_ID,
        education: [{ institution: 'MIT' }],
        experience: [{ company: 'Acme' }],
      }],
      user_profiles: [{ id: USER_ID, expected_role_ids: ['role-1'], target_role: null }],
    }));

    await expect(generateCareerReport(USER_ID, 0)).rejects.toMatchObject({
      message: 'AI generation failed',
      statusCode: 502,
    });
    expect(resolveExpectedRoleIdsFromTitle).not.toHaveBeenCalled();
  });

  it('education-only (no experience) plus role is sufficient — OR branch satisfied via a single alternative', async () => {
    mockFrom.mockImplementation(makeSupabaseFrom({
      onboarding_progress: [{ id: USER_ID, education: [{ institution: 'MIT' }], experience: [] }],
      user_profiles: [{ id: USER_ID, expected_role_ids: ['role-1'], target_role: null }],
    }));

    await expect(generateCareerReport(USER_ID, 0)).rejects.toMatchObject({
      message: 'AI generation failed',
      statusCode: 502,
    });
  });

  it('experience-only (no education) plus role is sufficient — OR branch satisfied via the other alternative', async () => {
    mockFrom.mockImplementation(makeSupabaseFrom({
      onboarding_progress: [{ id: USER_ID, education: [], experience: [{ company: 'Acme' }] }],
      user_profiles: [{ id: USER_ID, expected_role_ids: ['role-1'], target_role: null }],
    }));

    await expect(generateCareerReport(USER_ID, 0)).rejects.toMatchObject({
      message: 'AI generation failed',
      statusCode: 502,
    });
  });

  it('unaffected 404 behavior: no onboarding_progress row at all', async () => {
    mockFrom.mockImplementation(makeSupabaseFrom({
      onboarding_progress: [],
      user_profiles: [{ id: USER_ID, expected_role_ids: ['role-1'], target_role: null }],
    }));

    await expect(generateCareerReport(USER_ID, 0)).rejects.toMatchObject({
      message: 'No onboarding data found',
      statusCode: 404,
    });
  });

  it('unaffected 400 behavior: missing userId', async () => {
    await expect(generateCareerReport(undefined, 0)).rejects.toMatchObject({
      message: 'userId is required',
      statusCode: 400,
    });
  });
});