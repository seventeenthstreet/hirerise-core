'use strict';

/**
 * src/modules/onboarding/__tests__/onboarding.helpers.completionSync.test.js
 *
 * WP-PRO-10E — exercises persistCompletionIfReady()'s new synchronization
 * of the approved Professional Profile's education/experience into
 * onboarding_progress at Completion time.
 *
 * The shared supabase test mocks under `testHelpers/` (see
 * knowledge-runtime and shared/repositories) only implement the read-side
 * query-builder surface (.select/.eq/.maybeSingle) — onboarding.helpers.js
 * also issues chained .update(payload).eq(field, value) writes, which
 * those mocks don't support. This file defines a small, self-contained
 * mock covering exactly the chains onboarding.helpers.js actually calls,
 * rather than stretching a read-only mock to fit.
 *
 * getProfessionalProfile() itself is mocked at the module boundary: its
 * own behaviour (composing user_profiles columns + jsonb blob) is already
 * covered by professionalProfile.validation.js. This file only needs to
 * verify how persistCompletionIfReady() *uses* whatever that function
 * returns.
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
          // Matches how onboarding.helpers.js uses .update().eq(): the
          // call site does not chain anything further, so .eq() itself
          // must resolve the write and be awaitable directly (including
          // inside Promise.all([...])).
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
  supabase: global.__onboardingCompletionSyncMock,
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

function baseTables(overrides = {}) {
  return {
    user_profiles: [{ id: USER_ID, onboarding_completed: false }],
    users: [{ id: USER_ID, onboarding_completed: false, professional_onboarding_complete: false }],
    onboarding_progress: [{ id: USER_ID, user_id: USER_ID, education: [], experience: [], step_history: [] }],
    ...overrides,
  };
}

// profileData / progressData passed directly into persistCompletionIfReady
// by its callers (controller / careerReport / linkedin / intake services) —
// distinct from the Professional Profile object returned by the mocked
// getProfessionalProfile(). Track B (WP-PRO-10G, refined WP-PRO-10GA) is
// the simplest way to satisfy evaluateCompletion() without needing a
// career_report in progressData: it requires career data — `experience`
// (dedicated column) or `professional_profile.education` (jsonb) — AND
// `expected_role_ids`, mirroring what professionalProfile.repository.js
// actually writes and preserving the original "career data AND expected
// role" business rule.
const COMPLETING_PROFILE_DATA = {
  experience: [{ company: 'Existing Co' }],
  expected_role_ids: ['role-1'],
};

describe('persistCompletionIfReady — WP-PRO-10E profile sync', () => {
  let persistCompletionIfReady;
  let getProfessionalProfile;

  beforeEach(() => {
    jest.resetModules();
    global.__onboardingCompletionSyncMock = createSupabaseMock(baseTables());

    ({ persistCompletionIfReady } = require('../onboarding.helpers'));
    ({ getProfessionalProfile } = require('../../../domain/professionalProfile/professionalProfile.repository'));
  });

  it('fills empty onboarding_progress education/experience from the approved profile on Completion', async () => {
    getProfessionalProfile.mockResolvedValue({
      education: [{ school: 'MIT' }],
      experience: [{ company: 'Acme' }],
    });

    await persistCompletionIfReady(USER_ID, { education: [], experience: [] }, COMPLETING_PROFILE_DATA);

    const row = global.__onboardingCompletionSyncMock._tables.onboarding_progress[0];
    expect(row.education).toEqual([{ school: 'MIT' }]);
    expect(row.experience).toEqual([{ company: 'Acme' }]);
    expect(row.completed).toBe(true);

    const usersRow = global.__onboardingCompletionSyncMock._tables.users[0];
    expect(usersRow.professional_onboarding_complete).toBe(true);
  });

  it('is idempotent: never overwrites already-populated arrays, even on a retried Completion', async () => {
    global.__onboardingCompletionSyncMock = createSupabaseMock(
      baseTables({
        onboarding_progress: [{
          id: USER_ID,
          user_id: USER_ID,
          education: [{ school: 'Existing University' }],
          experience: [],
          step_history: [],
        }],
      })
    );
    jest.resetModules();
    ({ persistCompletionIfReady } = require('../onboarding.helpers'));
    ({ getProfessionalProfile } = require('../../../domain/professionalProfile/professionalProfile.repository'));

    getProfessionalProfile.mockResolvedValue({
      education: [{ school: 'MIT' }],       // must NOT clobber the existing entry
      experience: [{ company: 'Acme' }],     // progress had none -> should be filled
    });

    await persistCompletionIfReady(
      USER_ID,
      { education: [{ school: 'Existing University' }], experience: [] },
      COMPLETING_PROFILE_DATA
    );

    const row = global.__onboardingCompletionSyncMock._tables.onboarding_progress[0];
    expect(row.education).toEqual([{ school: 'Existing University' }]);
    expect(row.experience).toEqual([{ company: 'Acme' }]);

    // Second, retried Completion call with the now-updated progress state
    // should produce byte-identical results — no duplication, no re-fetch
    // clobbering.
    await persistCompletionIfReady(
      USER_ID,
      { education: [{ school: 'Existing University' }], experience: [{ company: 'Acme' }] },
      COMPLETING_PROFILE_DATA
    );

    const rowAfterRetry = global.__onboardingCompletionSyncMock._tables.onboarding_progress[0];
    expect(rowAfterRetry.education).toEqual([{ school: 'Existing University' }]);
    expect(rowAfterRetry.experience).toEqual([{ company: 'Acme' }]);
  });

  it('leaves education/experience untouched when the approved profile has neither (preserves pre-existing 422 behaviour upstream)', async () => {
    getProfessionalProfile.mockResolvedValue({ education: [], experience: [] });

    await persistCompletionIfReady(USER_ID, { education: [], experience: [] }, COMPLETING_PROFILE_DATA);

    const row = global.__onboardingCompletionSyncMock._tables.onboarding_progress[0];
    expect(row.education).toEqual([]);
    expect(row.experience).toEqual([]);
    // Completion itself still proceeds — sync has no data to offer, but
    // that's an upstream data problem, not a reason to block Completion.
    expect(row.completed).toBe(true);
  });

  it('fails Completion entirely (no flags persisted) if the profile sync read fails', async () => {
    getProfessionalProfile.mockRejectedValue(new Error('db unavailable'));

    await expect(
      persistCompletionIfReady(USER_ID, { education: [], experience: [] }, COMPLETING_PROFILE_DATA)
    ).rejects.toThrow('Failed to persist onboarding completion');

    const row = global.__onboardingCompletionSyncMock._tables.onboarding_progress[0];
    const usersRow = global.__onboardingCompletionSyncMock._tables.users[0];
    // Nothing should have been written — the sync read failed before the
    // Promise.all of writes was ever reached.
    expect(row.completed).toBeUndefined();
    expect(usersRow.professional_onboarding_complete).toBe(false);
  });

  it('is a no-op (no sync read, no writes) when onboarding_completed is already true', async () => {
    await persistCompletionIfReady(USER_ID, { education: [], experience: [] }, { onboarding_completed: true });

    expect(getProfessionalProfile).not.toHaveBeenCalled();
  });

  it('is a no-op when completion criteria are not met', async () => {
    await persistCompletionIfReady(USER_ID, { education: [], experience: [] }, {});

    expect(getProfessionalProfile).not.toHaveBeenCalled();
  });
});

// WP-PRO-11 Part 5 — persistCompletionIfReady() previously returned
// undefined on every path, so completeOnboarding() had no way to know
// whether completion actually happened and always reported
// `step: 'complete'`. These tests lock in the return-value contract for
// each of the three paths through the function.
describe('persistCompletionIfReady — WP-PRO-11 return value contract', () => {
  let persistCompletionIfReady;
  let getProfessionalProfile;

  beforeEach(() => {
    jest.resetModules();
    global.__onboardingCompletionSyncMock = createSupabaseMock(baseTables());

    ({ persistCompletionIfReady } = require('../onboarding.helpers'));
    ({ getProfessionalProfile } = require('../../../domain/professionalProfile/professionalProfile.repository'));
  });

  it('returns { isComplete: true, alreadyCompleted: true } without touching the sync read when already completed', async () => {
    const result = await persistCompletionIfReady(
      USER_ID,
      { education: [], experience: [] },
      { onboarding_completed: true }
    );

    expect(result).toEqual({ isComplete: true, alreadyCompleted: true });
    expect(getProfessionalProfile).not.toHaveBeenCalled();
  });

  it('returns { isComplete: false, alreadyCompleted: false, ... } with no writes when completion criteria are not met', async () => {
    const result = await persistCompletionIfReady(USER_ID, { education: [], experience: [] }, {});

    expect(result).toMatchObject({
      isComplete:   false,
      alreadyCompleted: false,
      trackA:       false,
      trackAUpload: false,
      trackB:       false,
    });

    const row = global.__onboardingCompletionSyncMock._tables.onboarding_progress[0];
    expect(row.completed).toBeUndefined();
  });

  it('returns { isComplete: true, alreadyCompleted: false, ... } once persistence actually happens', async () => {
    getProfessionalProfile.mockResolvedValue({
      education:  [{ school: 'MIT' }],
      experience: [{ company: 'Acme' }],
    });

    const result = await persistCompletionIfReady(
      USER_ID,
      { education: [], experience: [] },
      COMPLETING_PROFILE_DATA
    );

    expect(result).toMatchObject({ isComplete: true, alreadyCompleted: false, trackB: true });

    const row = global.__onboardingCompletionSyncMock._tables.onboarding_progress[0];
    expect(row.completed).toBe(true);
  });
});