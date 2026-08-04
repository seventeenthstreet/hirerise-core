'use strict';

/**
 * @file src/modules/onboarding/__tests__/onboarding.helpers.spceTrackBMigration.test.js
 *
 * WP-SPCE-03B — Professional Onboarding Track B Migration — output-diff and
 * regression tests.
 *
 * Exercises the real, unmocked evaluateCompletion() (both `progress` and
 * `profile` arguments are plain objects — the function is pure, no I/O) and
 * compares it against a frozen reimplementation of the PRE-migration inline
 * Track B calculation, across every fixture identified in
 * WP-SPCE-03B-PRE_Migration_Readiness_Audit.md §10.
 *
 * Also regression-tests that Track A, Track A Upload, and the overall
 * isComplete OR-composition are byte-for-byte unaffected by the migration
 * — these are the highest-priority fixtures per the audit, since they are
 * the ones that would silently break if the adapter accidentally touched
 * anything beyond the Track B sub-expression.
 */

const { evaluateCompletion } = require('../onboarding.helpers');

// ─────────────────────────────────────────────────────────────────────────
// Frozen "legacy" Track B reference implementation — copied verbatim from
// the pre-migration onboarding.helpers.js (git history / WP-SPCE-03B-PRE
// audit §5, Track B Analysis), kept ONLY in this test file so the migrated
// implementation has something independent to be diffed against.
// ─────────────────────────────────────────────────────────────────────────
function legacyTrackB(profile = {}) {
  const professionalProfileBlob =
    (profile.professional_profile && typeof profile.professional_profile === 'object')
      ? profile.professional_profile
      : {};

  const careerDataExists =
    Boolean(profile.experience?.length) ||
    Boolean(professionalProfileBlob.education?.length);

  return careerDataExists && Boolean(profile.expected_role_ids?.length);
}

describe('WP-SPCE-03B — Track B output-diff (legacy inline calc vs SPCE-backed evaluateCompletion)', () => {
  const FIXTURES = [
    { name: 'empty profile', profile: {} },
    {
      name: 'education only (canonical blob), no role',
      profile: { professional_profile: { education: [{ institution: 'MIT' }] } },
    },
    {
      name: 'experience only, no role',
      profile: { experience: [{ title: 'Engineer' }] },
    },
    {
      name: 'education + role',
      profile: {
        professional_profile: { education: [{ institution: 'MIT' }] },
        expected_role_ids: ['role-1'],
      },
    },
    {
      name: 'experience + role',
      profile: {
        experience: [{ title: 'Engineer' }],
        expected_role_ids: ['role-1'],
      },
    },
    {
      name: 'education + experience + role',
      profile: {
        experience: [{ title: 'Engineer' }],
        professional_profile: { education: [{ institution: 'MIT' }] },
        expected_role_ids: ['role-1'],
      },
    },
    {
      name: 'role only, no education/experience',
      profile: { expected_role_ids: ['role-1'] },
    },
    {
      name: 'Resume-Upload-only user whose canonical profile writes happen to satisfy Track B (coupling case, WP-SPCE-03B-PRE §9)',
      profile: {
        experience: [{ title: 'Engineer' }],
        expected_role_ids: ['role-1'],
        // No guided_* step history would be present for this user — this
        // fixture only exercises evaluateCompletion()'s data-level result,
        // not track detection, which is a separate (untouched) module.
      },
    },
    {
      name: 'dead career_history column populated, nothing else (WP-PRO-10G — must NOT be read)',
      profile: { career_history: [{ title: 'Old Job' }] },
    },
    {
      name: 'empty arrays (must count as not-present, not present)',
      profile: { experience: [], professional_profile: { education: [] }, expected_role_ids: [] },
    },
  ];

  test.each(FIXTURES.map((f) => [f.name, f.profile]))(
    'trackB matches legacy calculation: %s',
    (_name, profile) => {
      const legacy = legacyTrackB(profile);
      const migrated = evaluateCompletion({}, profile).trackB;
      expect(migrated).toBe(legacy);
    }
  );

  it('returns missingFields-equivalent-null shape unaffected — evaluateCompletion() return contract has no missingFields key', () => {
    const result = evaluateCompletion({}, { expected_role_ids: ['role-1'] });
    expect(result).not.toHaveProperty('missingFields');
    expect(Object.keys(result).sort()).toEqual(['isComplete', 'trackA', 'trackAUpload', 'trackB'].sort());
  });
});

describe('WP-SPCE-03B — Track A regression (must be completely unaffected)', () => {
  it('trackA true: education/experience in onboarding_progress + career_report flag', () => {
    const progress = { education: [{ institution: 'MIT' }], career_report: { id: 'report-1' } };
    const result = evaluateCompletion(progress, {});
    expect(result.trackA).toBe(true);
    expect(result.trackB).toBe(false);
    expect(result.isComplete).toBe(true);
  });

  it('trackA false: education present but no career_report yet', () => {
    const progress = { education: [{ institution: 'MIT' }] };
    const result = evaluateCompletion(progress, {});
    expect(result.trackA).toBe(false);
  });

  it('isComplete stays true via trackA alone even when the canonical profile (trackB) is completely empty', () => {
    const progress = { experience: [{ title: 'Engineer' }], career_report: true };
    const result = evaluateCompletion(progress, {});
    expect(result.trackA).toBe(true);
    expect(result.trackB).toBe(false);
    expect(result.isComplete).toBe(true);
  });
});

describe('WP-SPCE-03B — Track A Upload regression (must be completely unaffected)', () => {
  it('trackAUpload true: cv_resume_id + personal_details.full_name', () => {
    const progress = { cv_resume_id: 'resume-1', personal_details: { full_name: 'Jane Doe' } };
    const result = evaluateCompletion(progress, {});
    expect(result.trackAUpload).toBe(true);
    expect(result.trackB).toBe(false);
    expect(result.isComplete).toBe(true);
  });

  it('trackAUpload true via legacy flat full_name fallback', () => {
    const progress = { cv_resume_id: 'resume-1', full_name: 'Jane Doe' };
    const result = evaluateCompletion(progress, {});
    expect(result.trackAUpload).toBe(true);
  });

  it('trackAUpload false: cv_resume_id present but no name anywhere', () => {
    const progress = { cv_resume_id: 'resume-1' };
    const result = evaluateCompletion(progress, {});
    expect(result.trackAUpload).toBe(false);
  });

  it('isComplete stays true via trackAUpload alone even when the canonical profile (trackB) is completely empty', () => {
    const progress = { cv_resume_id: 'resume-1', personal_details: { full_name: 'Jane Doe' } };
    const result = evaluateCompletion(progress, {});
    expect(result.trackAUpload).toBe(true);
    expect(result.trackB).toBe(false);
    expect(result.isComplete).toBe(true);
  });
});

describe('WP-SPCE-03B — Overall completion OR-composition regression', () => {
  it('all three tracks false -> isComplete false', () => {
    const result = evaluateCompletion({}, {});
    expect(result).toEqual({
      isComplete: false,
      trackA: false,
      trackAUpload: false,
      trackB: false,
    });
  });

  it('only trackB true -> isComplete true (the migrated branch alone can still complete onboarding)', () => {
    const profile = {
      experience: [{ title: 'Engineer' }],
      expected_role_ids: ['role-1'],
    };
    const result = evaluateCompletion({}, profile);
    expect(result).toEqual({
      isComplete: true,
      trackA: false,
      trackAUpload: false,
      trackB: true,
    });
  });

  it('multiple tracks true simultaneously -> isComplete true, each flag independently accurate', () => {
    const progress = { cv_resume_id: 'r1', full_name: 'Jane Doe' };
    const profile = { experience: [{ title: 'Engineer' }], expected_role_ids: ['role-1'] };
    const result = evaluateCompletion(progress, profile);
    expect(result).toEqual({
      isComplete: true,
      trackA: false,
      trackAUpload: true,
      trackB: true,
    });
  });
});

describe('WP-SPCE-03B — professional-onboarding.progression.js unaffected (reads completion.trackAUpload, not .trackB)', () => {
  it('isStepComplete profile_review derivation still reads trackAUpload, independent of trackB migration', () => {
    const { isStepComplete } = require('../professional-onboarding.progression');

    const completionTrackAUploadOnly = { trackA: false, trackAUpload: true, trackB: false };
    const stepDef = { derivedFrom: 'trackAUpload' };
    expect(isStepComplete(stepDef, { completedSteps: [], progress: {}, completion: completionTrackAUploadOnly })).toBe(true);

    const completionTrackBOnly = { trackA: false, trackAUpload: false, trackB: true };
    expect(isStepComplete(stepDef, { completedSteps: [], progress: {}, completion: completionTrackBOnly })).toBe(false);
  });
});
