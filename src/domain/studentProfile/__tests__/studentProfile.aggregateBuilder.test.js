'use strict';

/**
 * __tests__/studentProfile.aggregateBuilder.test.js
 *
 * Unit tests for the Aggregate Builder, per the work package's Testing
 * requirement: "Mock existing repositories. No database dependency."
 * academic.repository.js, activity.repository.js, and
 * cognitive.repository.js are mocked directly; the legacy adapter's
 * supabase call is exercised via a minimal chainable mock of
 * `config/supabase`.
 */

function makeLegacyQueryResult({ data = null, error = null } = {}) {
  return {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data, error }),
  };
}

describe('studentProfile.aggregateBuilder', () => {
  let buildStudentProfile;
  let hasNoData;
  let collectSourceTimestamps;
  let validateStudentProfileShape;
  let academicRepository;
  let activityRepository;
  let cognitiveRepository;
  let supabaseFromMock;

  beforeEach(() => {
    jest.resetModules();

    supabaseFromMock = jest.fn();

    jest.doMock('../../../config/supabase', () => ({
      supabase: { from: supabaseFromMock },
    }));

    jest.doMock('../../../utils/logger', () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }));

    jest.doMock('../../../modules/student-onboarding/repositories/academic.repository', () => ({
      fetchAcademicData: jest.fn(),
    }));
    jest.doMock('../../../modules/student-onboarding/repositories/activity.repository', () => ({
      fetchStudentActivityData: jest.fn(),
    }));
    jest.doMock('../../../modules/student-onboarding/repositories/cognitive.repository', () => ({
      fetchStudentCognitiveData: jest.fn(),
    }));

    ({
      buildStudentProfile,
      hasNoData,
      collectSourceTimestamps,
      validateStudentProfileShape,
    } = require('../studentProfile.aggregateBuilder'));

    academicRepository = require('../../../modules/student-onboarding/repositories/academic.repository');
    activityRepository = require('../../../modules/student-onboarding/repositories/activity.repository');
    cognitiveRepository = require('../../../modules/student-onboarding/repositories/cognitive.repository');
  });

  function mockLegacyRow(row) {
    supabaseFromMock.mockReturnValue(makeLegacyQueryResult({ data: row }));
  }

  function mockLegacyError(error) {
    supabaseFromMock.mockReturnValue(makeLegacyQueryResult({ error }));
  }

  describe('buildStudentProfile', () => {
    it('returns null when no wrapped source has any data for the student', async () => {
      mockLegacyRow(null);
      academicRepository.fetchAcademicData.mockResolvedValue({ records: [], subjects: [] });
      activityRepository.fetchStudentActivityData.mockResolvedValue({ activities: [], achievements: [], reflection: null });
      cognitiveRepository.fetchStudentCognitiveData.mockResolvedValue({ responses: [], signals: null });

      const result = await buildStudentProfile('student-empty');
      expect(result).toBeNull();
    });

    it('assembles a full canonical profile from all four sources', async () => {
      mockLegacyRow({
        grade: 'class_11',
        academic_marks: { legacy: true },
        interests: ['music'],
        strengths: { problem_solving: 4 },
        career_curiosities: ['space'],
        learning_styles: ['visual'],
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-05T00:00:00.000Z',
      });
      academicRepository.fetchAcademicData.mockResolvedValue({
        records: [{ academic_year: 'class_11', created_at: '2026-02-01T00:00:00.000Z', updated_at: '2026-02-02T00:00:00.000Z' }],
        subjects: [{ academic_year: 'class_11', subject: 'physics', marks_obtained: 91 }],
      });
      activityRepository.fetchStudentActivityData.mockResolvedValue({
        activities: [
          {
            activity_key: 'robotics_club',
            activity_category: 'stem',
            leadership_level: 'member',
            duration_months: 6,
            created_at: '2026-03-01T00:00:00.000Z',
            updated_at: '2026-03-02T00:00:00.000Z',
          },
        ],
        achievements: [
          {
            achievement_title: 'Regional Finalist',
            achievement_level: 'regional',
            achievement_year: 2025,
            created_at: '2026-03-05T00:00:00.000Z',
            updated_at: '2026-03-06T00:00:00.000Z',
          },
        ],
        reflection: null,
      });
      cognitiveRepository.fetchStudentCognitiveData.mockResolvedValue({
        responses: [
          { question_id: 'q-1', selected_option_keys: ['a'], created_at: '2026-04-01T00:00:00.000Z', updated_at: '2026-04-01T00:00:00.000Z' },
        ],
        signals: null,
      });

      const profile = await buildStudentProfile('student-1');

      expect(profile.studentId).toBe('student-1');
      expect(profile.schemaContractVersion).toBe(1);
      expect(profile.academicInformation.currentGradeLevel).toBe('class_11');
      expect(profile.academicInformation.academicRecords).toEqual([
        { academicYear: 'class_11', subjects: [{ subjectName: 'physics', score: 91 }] },
      ]);
      expect(profile.activities.activityRecords).toHaveLength(1);
      expect(profile.achievements.achievementRecords).toEqual([
        { achievementName: 'Regional Finalist', achievementType: 'regional', dateAwarded: 2025, issuingBody: null },
      ]);
      expect(profile.assessments.cognitiveAssessmentRecords).toHaveLength(1);
      expect(profile.careerAspirations.statedInterests).toEqual(['music']);

      // createdAt = min() across all sources = legacy row's created_at
      expect(profile.createdAt).toBe('2026-01-01T00:00:00.000Z');
      // updatedAt = max() across all sources = cognitive response's updated_at
      expect(profile.updatedAt).toBe('2026-04-01T00:00:00.000Z');

      expect(profile.sourceSystemProvenance).toEqual(['legacy_onboarding', 'onboarding_v2']);
    });

    it('produces a valid profile with four empty subdomains when only one subdomain has data', async () => {
      mockLegacyRow(null);
      academicRepository.fetchAcademicData.mockResolvedValue({ records: [], subjects: [] });
      activityRepository.fetchStudentActivityData.mockResolvedValue({ activities: [], achievements: [], reflection: null });
      cognitiveRepository.fetchStudentCognitiveData.mockResolvedValue({
        responses: [{ question_id: 'q-1', selected_option_keys: ['a'], created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' }],
        signals: null,
      });

      const profile = await buildStudentProfile('student-2');

      expect(profile).not.toBeNull();
      expect(profile.academicInformation.academicRecords).toEqual([]);
      expect(profile.activities.activityRecords).toEqual([]);
      expect(profile.achievements.achievementRecords).toEqual([]);
      expect(profile.careerAspirations.statedInterests).toEqual([]);
      expect(profile.assessments.cognitiveAssessmentRecords).toHaveLength(1);
      expect(profile.sourceSystemProvenance).toEqual(['onboarding_v2']);
    });

    it('rejects the whole read when one adapter fails (fail-closed, no partial profile)', async () => {
      mockLegacyRow({ grade: 'class_9' });
      academicRepository.fetchAcademicData.mockResolvedValue({ records: [], subjects: [] });
      activityRepository.fetchStudentActivityData.mockResolvedValue({ activities: [], achievements: [], reflection: null });
      cognitiveRepository.fetchStudentCognitiveData.mockRejectedValue(new Error('db timeout'));

      await expect(buildStudentProfile('student-3')).rejects.toMatchObject({
        name: 'RepositoryLoadError',
        subdomain: 'assessments',
      });
    });

    it('rejects when the legacy adapter query itself errors', async () => {
      mockLegacyError({ message: 'connection refused' });
      academicRepository.fetchAcademicData.mockResolvedValue({ records: [], subjects: [] });
      activityRepository.fetchStudentActivityData.mockResolvedValue({ activities: [], achievements: [], reflection: null });
      cognitiveRepository.fetchStudentCognitiveData.mockResolvedValue({ responses: [], signals: null });

      await expect(buildStudentProfile('student-4')).rejects.toMatchObject({
        name: 'RepositoryLoadError',
        subdomain: 'legacy',
      });
    });

    it('throws ValidationError when studentId is missing', async () => {
      await expect(buildStudentProfile()).rejects.toMatchObject({ name: 'ValidationError' });
    });
  });

  describe('hasNoData', () => {
    it('is true only when every source is empty', () => {
      expect(
        hasNoData({
          legacyRow: null,
          academicRaw: { records: [], subjects: [] },
          activityRaw: { activities: [], achievements: [] },
          cognitiveRaw: { responses: [], signals: null },
        }),
      ).toBe(true);
    });

    it('is false when any single source has data', () => {
      expect(
        hasNoData({
          legacyRow: { grade: 'class_9' },
          academicRaw: { records: [], subjects: [] },
          activityRaw: { activities: [], achievements: [] },
          cognitiveRaw: { responses: [], signals: null },
        }),
      ).toBe(false);
    });
  });

  describe('collectSourceTimestamps', () => {
    it('gathers a {createdAt, updatedAt} pair per row across every source', () => {
      const result = collectSourceTimestamps({
        legacyRow: { created_at: 'a', updated_at: 'b' },
        academicRaw: { records: [{ created_at: 'c', updated_at: 'd' }], subjects: [] },
        activityRaw: { activities: [], achievements: [] },
        cognitiveRaw: { responses: [], signals: null },
      });
      expect(result).toEqual([
        { createdAt: 'a', updatedAt: 'b' },
        { createdAt: 'c', updatedAt: 'd' },
      ]);
    });
  });

  describe('validateStudentProfileShape', () => {
    it('throws ValidationError when studentId is missing', () => {
      expect(() => validateStudentProfileShape({ schemaContractVersion: 1, sourceSystemProvenance: [] })).toThrow(
        'studentId is required',
      );
    });

    it('throws ValidationError when a subdomain container is missing', () => {
      expect(() =>
        validateStudentProfileShape({
          studentId: 's-1',
          schemaContractVersion: 1,
          sourceSystemProvenance: [],
          academicInformation: {},
          activities: {},
          achievements: {},
          assessments: {},
          // careerAspirations missing
        }),
      ).toThrow(/careerAspirations/);
    });
  });
});
