'use strict';

/**
 * __tests__/studentProfile.writeValidation.test.js
 *
 * Unit tests for write-time structural validation. Pure functions — no
 * mocking needed.
 */

const {
  validateAcademicInformationPartial,
  validateActivitiesPartial,
  validateAchievementPayload,
  validateDeleteAchievementArgs,
  validateAssessmentsPartial,
  validateCareerAspirationsPartial,
} = require('../studentProfile.writeValidation');

describe('studentProfile.writeValidation', () => {
  describe('validateAcademicInformationPartial', () => {
    it('accepts a valid partial with academicRecords only', () => {
      expect(() =>
        validateAcademicInformationPartial({
          academicRecords: [{ academicYear: 'class_10', subjects: [{ subjectName: 'physics', score: 90 }] }],
        }),
      ).not.toThrow();
    });

    it('accepts an empty partial', () => {
      expect(() => validateAcademicInformationPartial({})).not.toThrow();
    });

    it('rejects a non-object payload', () => {
      expect(() => validateAcademicInformationPartial(null)).toThrow('must be an object');
    });

    it('rejects academicRecords that is not an array', () => {
      expect(() => validateAcademicInformationPartial({ academicRecords: {} })).toThrow('must be an array');
    });

    it('rejects a record missing academicYear', () => {
      expect(() => validateAcademicInformationPartial({ academicRecords: [{ subjects: [] }] })).toThrow('academicYear');
    });

    it('rejects a subject missing subjectName', () => {
      expect(() =>
        validateAcademicInformationPartial({ academicRecords: [{ academicYear: 'class_10', subjects: [{ score: 5 }] }] }),
      ).toThrow('subjectName');
    });

    it('rejects a non-numeric score', () => {
      expect(() =>
        validateAcademicInformationPartial({
          academicRecords: [{ academicYear: 'class_10', subjects: [{ subjectName: 'physics', score: 'A' }] }],
        }),
      ).toThrow('score');
    });

    it('accepts a null score', () => {
      expect(() =>
        validateAcademicInformationPartial({
          academicRecords: [{ academicYear: 'class_10', subjects: [{ subjectName: 'physics', score: null }] }],
        }),
      ).not.toThrow();
    });
  });

  describe('validateActivitiesPartial', () => {
    it('accepts a valid activityRecords entry', () => {
      expect(() =>
        validateActivitiesPartial({ activityRecords: [{ activityName: 'debate_club', activityType: 'academic' }] }),
      ).not.toThrow();
    });

    it('rejects a missing activityName', () => {
      expect(() => validateActivitiesPartial({ activityRecords: [{ activityType: 'academic' }] })).toThrow('activityName');
    });

    it('rejects a missing activityType', () => {
      expect(() => validateActivitiesPartial({ activityRecords: [{ activityName: 'debate_club' }] })).toThrow('activityType');
    });

    it('rejects a non-numeric duration', () => {
      expect(() =>
        validateActivitiesPartial({ activityRecords: [{ activityName: 'x', activityType: 'y', duration: '12' }] }),
      ).toThrow('duration');
    });
  });

  describe('validateAchievementPayload', () => {
    it('accepts a valid payload', () => {
      expect(() =>
        validateAchievementPayload('debate_club', { achievementName: 'State Champion', achievementType: 'state', dateAwarded: 2025 }),
      ).not.toThrow();
    });

    it('rejects a missing activityKey', () => {
      expect(() => validateAchievementPayload('', { achievementName: 'x', achievementType: 'y' })).toThrow('activityKey');
    });

    it('rejects a missing achievementName', () => {
      expect(() => validateAchievementPayload('debate_club', { achievementType: 'state' })).toThrow('achievementName');
    });

    it('rejects a missing achievementType', () => {
      expect(() => validateAchievementPayload('debate_club', { achievementName: 'x' })).toThrow('achievementType');
    });

    it('rejects a non-numeric dateAwarded', () => {
      expect(() =>
        validateAchievementPayload('debate_club', { achievementName: 'x', achievementType: 'y', dateAwarded: '2025' }),
      ).toThrow('dateAwarded');
    });
  });

  describe('validateDeleteAchievementArgs', () => {
    it('accepts a valid achievementId', () => {
      expect(() => validateDeleteAchievementArgs('achievement-1')).not.toThrow();
    });

    it('rejects a missing achievementId', () => {
      expect(() => validateDeleteAchievementArgs('')).toThrow('achievementId');
    });
  });

  describe('validateAssessmentsPartial', () => {
    it('accepts a valid entry with selectedOptionKeys', () => {
      expect(() =>
        validateAssessmentsPartial({ cognitiveAssessmentRecords: [{ assessmentType: 'q-1', selectedOptionKeys: ['a'] }] }),
      ).not.toThrow();
    });

    it('rejects a missing assessmentType', () => {
      expect(() => validateAssessmentsPartial({ cognitiveAssessmentRecords: [{ selectedOptionKeys: ['a'] }] })).toThrow(
        'assessmentType',
      );
    });

    it('rejects a missing selectedOptionKeys', () => {
      expect(() => validateAssessmentsPartial({ cognitiveAssessmentRecords: [{ assessmentType: 'q-1' }] })).toThrow(
        'selectedOptionKeys',
      );
    });
  });

  describe('validateCareerAspirationsPartial', () => {
    it('accepts a valid partial', () => {
      expect(() =>
        validateCareerAspirationsPartial({ statedInterests: ['music'], statedStrengths: [], careerCuriosities: [], learningStyles: [] }),
      ).not.toThrow();
    });

    it('rejects a non-array statedInterests', () => {
      expect(() => validateCareerAspirationsPartial({ statedInterests: 'music' })).toThrow('statedInterests');
    });

    it('rejects a non-array statedStrengths', () => {
      expect(() => validateCareerAspirationsPartial({ statedStrengths: 'strong' })).toThrow('statedStrengths');
    });
  });
});
