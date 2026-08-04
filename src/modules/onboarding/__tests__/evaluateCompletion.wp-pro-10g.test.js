'use strict';

/**
 * src/modules/onboarding/__tests__/evaluateCompletion.wp-pro-10g.test.js
 *
 * WP-PRO-10G/10GA — verifies evaluateCompletion()'s modernized Track B
 * (career data via `experience`/`professional_profile.education` AND
 * `expected_role_ids` — the original business rule, with only the
 * obsolete `career_history` signal replaced per WP-PRO-10GA), and the
 * end-to-end runtime path it unblocks: persistCompletionIfReady() ->
 * buildProfileSyncPatch() -> onboarding_progress -> generateCareerReport()
 * no longer 422ing. Covers the 7 scenarios the work package specifies.
 *
 * Reuses the same minimal supabase mock pattern as
 * onboarding.helpers.completionSync.test.js (the shared testHelpers mocks
 * don't support the .update().eq() chains this module relies on).
 */

function createSupabaseMock(initialTables) {
  const tables = JSON.parse(JSON.stringify(initialTables));

  function makeQuery(table) {
    const filters = [];
    let mode = null;
    let updatePayload = null;

    const api = {
      select() {
        mode = 'select';
        return api;
      },
      update(payload) {
        mode = 'update';
        updatePayload = payload;
        return api;
      },
      eq(field, value) {
        filters.push({ field, value });

        if (mode === 'update') {
          return (async () => {
            const rows = tables[table] || (tables[table] = []);
            const idx = rows.findIndex((r) => filters.every((f) => r[f.field] === f.value));
            if (idx === -1) {
              return { data: null, error: { message: `row not found in ${table}` } };
            }
            rows[idx] = { ...rows[idx], ...updatePayload };
            return { data: rows[idx], error: null };
          })();
        }

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
  }

  return {
    from(table) {
      return makeQuery(table);
    },
    _tables: tables,
  };
}

jest.mock('../../../config/supabase', () => ({
  supabase: global.__wpPro10gSupabaseMock,
}));

jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../../../domain/professionalProfile/professionalProfile.repository', () => ({
  getProfessionalProfile: jest.fn(),
}));

const USER_ID = 'user-1';

describe('evaluateCompletion() — WP-PRO-10G/10GA Track B modernization (unit)', () => {
  let evaluateCompletion;

  beforeEach(() => {
    jest.resetModules();
    global.__wpPro10gSupabaseMock = createSupabaseMock({
      user_profiles: [{ id: USER_ID }],
      users: [{ id: USER_ID }],
      onboarding_progress: [{ id: USER_ID, user_id: USER_ID }],
    });
    ({ evaluateCompletion } = require('../onboarding.helpers'));
  });

  it('does NOT complete on the old, obsolete career_history signal, even with expected_role_ids present', () => {
    const result = evaluateCompletion(
      {},
      { career_history: [{ title: 'Engineer' }], expected_role_ids: ['role-1'] }
    );
    expect(result.isComplete).toBe(false);
    expect(result.trackB).toBe(false);
  });

  it('completes via the dedicated `experience` column + expected_role_ids', () => {
    const result = evaluateCompletion(
      {},
      { experience: [{ company: 'Acme' }], expected_role_ids: ['role-1'] }
    );
    expect(result.trackB).toBe(true);
    expect(result.isComplete).toBe(true);
  });

  it('completes via `professional_profile.education` (jsonb) + expected_role_ids', () => {
    const result = evaluateCompletion(
      {},
      { professional_profile: { education: [{ school: 'MIT' }] }, expected_role_ids: ['role-1'] }
    );
    expect(result.trackB).toBe(true);
    expect(result.isComplete).toBe(true);
  });

  it('does NOT complete (WP-PRO-10GA): career data present but expected_role_ids missing', () => {
    const result = evaluateCompletion(
      {},
      { experience: [{ company: 'Acme' }], professional_profile: { education: [{ school: 'MIT' }] } }
    );
    expect(result.trackB).toBe(false);
    expect(result.isComplete).toBe(false);
  });

  it('does NOT complete: expected_role_ids present but no career data', () => {
    const result = evaluateCompletion({}, { expected_role_ids: ['role-1'] });
    expect(result.trackB).toBe(false);
    expect(result.isComplete).toBe(false);
  });

  it('does not complete when the profile has neither experience nor education', () => {
    const result = evaluateCompletion({}, { professional_profile: {}, expected_role_ids: ['role-1'] });
    expect(result.trackB).toBe(false);
    expect(result.isComplete).toBe(false);
  });

  it('does not throw when professional_profile is not an object', () => {
    expect(() => evaluateCompletion({}, { professional_profile: 'not-an-object' })).not.toThrow();
    const result = evaluateCompletion({}, { professional_profile: 'not-an-object' });
    expect(result.trackB).toBe(false);
  });

  it('leaves Track A and Track A-Upload semantics untouched', () => {
    const trackAOnly = evaluateCompletion(
      { education: [{ school: 'MIT' }], career_report: { overallAssessment: 'x' } },
      {}
    );
    expect(trackAOnly.trackA).toBe(true);
    expect(trackAOnly.isComplete).toBe(true);

    const trackAUploadOnly = evaluateCompletion(
      { cv_resume_id: 'resume-1', personal_details: { full_name: 'Jane Doe' } },
      {}
    );
    expect(trackAUploadOnly.trackAUpload).toBe(true);
    expect(trackAUploadOnly.isComplete).toBe(true);
  });
});

describe('End-to-end runtime path — WP-PRO-10G/10GA Scenarios 1-6', () => {
  let persistCompletionIfReady;
  let getProfessionalProfile;

  beforeEach(() => {
    jest.resetModules();
    global.__wpPro10gSupabaseMock = createSupabaseMock({
      user_profiles: [{
        id: USER_ID,
        onboarding_completed: false,
        experience: [{ company: 'Acme', title: 'Engineer' }],
        professional_profile: { education: [{ school: 'MIT' }] },
        expected_role_ids: ['role-1'],
      }],
      users: [{ id: USER_ID, onboarding_completed: false, professional_onboarding_complete: false }],
      onboarding_progress: [{ id: USER_ID, user_id: USER_ID, education: [], experience: [], step_history: [] }],
    });

    ({ persistCompletionIfReady, evaluateCompletion } = require('../onboarding.helpers'));
    ({ getProfessionalProfile } = require('../../../domain/professionalProfile/professionalProfile.repository'));

    // Mirrors what completeOnboarding's controller passes: the composed
    // Professional Profile the WP-PRO-10E sync reads.
    getProfessionalProfile.mockResolvedValue({
      education: [{ school: 'MIT' }],
      experience: [{ company: 'Acme', title: 'Engineer' }],
    });
  });

  it('Scenario 1: evaluateCompletion() returns true for a Resume Upload -> Review -> /complete profile', () => {
    const profileRow = global.__wpPro10gSupabaseMock._tables.user_profiles[0];
    const progressRow = global.__wpPro10gSupabaseMock._tables.onboarding_progress[0];
    const completion = evaluateCompletion(progressRow, profileRow);
    expect(completion.isComplete).toBe(true);
  });

  it('Scenarios 2-5: persistCompletionIfReady() executes, buildProfileSyncPatch() runs, and onboarding_progress is synchronized', async () => {
    const profileRow = global.__wpPro10gSupabaseMock._tables.user_profiles[0];
    const progressRow = global.__wpPro10gSupabaseMock._tables.onboarding_progress[0];

    await persistCompletionIfReady(USER_ID, progressRow, profileRow);

    // Scenario 2: persistCompletionIfReady actually wrote completion state
    // (only reachable if evaluateCompletion() returned true and the
    // function did not hit its early return).
    const usersRow = global.__wpPro10gSupabaseMock._tables.users[0];
    expect(usersRow.professional_onboarding_complete).toBe(true);

    // Scenario 3: buildProfileSyncPatch()'s only observable effect is the
    // getProfessionalProfile() read it performs — confirm it happened.
    expect(getProfessionalProfile).toHaveBeenCalledWith(USER_ID);

    // Scenario 4 & 5: onboarding_progress now carries the synchronized data.
    const syncedProgress = global.__wpPro10gSupabaseMock._tables.onboarding_progress[0];
    expect(syncedProgress.education).toEqual([{ school: 'MIT' }]);
    expect(syncedProgress.experience).toEqual([{ company: 'Acme', title: 'Engineer' }]);
  });

  it('Scenario 6: generateCareerReport() no longer 422s once onboarding_progress carries synchronized data', async () => {
    // Simulate the state after Scenario 2-5 already ran: onboarding_progress
    // has been synchronized. generateCareerReport()'s 422 gate
    // (onboarding.careerReport.service.js) only checks
    // `progress.education?.length || progress.experience?.length` on the
    // row it reads — reproduce that exact check against the post-sync row,
    // since generateCareerReport() itself is explicitly out of scope for
    // WP-PRO-10G to modify or invoke directly here.
    const profileRow = global.__wpPro10gSupabaseMock._tables.user_profiles[0];
    const progressRow = global.__wpPro10gSupabaseMock._tables.onboarding_progress[0];
    await persistCompletionIfReady(USER_ID, progressRow, profileRow);

    const postSyncProgress = global.__wpPro10gSupabaseMock._tables.onboarding_progress[0];
    const wouldReturn422 =
      !postSyncProgress.education?.length && !postSyncProgress.experience?.length;

    expect(wouldReturn422).toBe(false);
  });
});
