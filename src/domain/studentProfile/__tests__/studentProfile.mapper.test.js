'use strict';

/**
 * __tests__/studentProfile.mapper.test.js
 *
 * Unit tests for the Canonical Mapper. Pure functions — no mocking needed.
 */

const {
  mapAcademicInformation,
  mapActivities,
  mapAchievements,
  mapAssessments,
  mapCareerAspirations,
} = require('../studentProfile.mapper');

describe('studentProfile.mapper', () => {
  describe('mapAcademicInformation', () => {
    it('groups subjects under their academic year and prefers marks_obtained for score', () => {
      const academicRaw = {
        records: [{ academic_year: 'class_10' }],
        subjects: [
          { academic_year: 'class_10', subject: 'mathematics', marks_obtained: 88, percentage: 90 },
          { academic_year: 'class_10', subject: 'physics', marks_obtained: null, percentage: 75 },
        ],
      };
      const legacyRow = { grade: 'class_10', academic_marks: { raw: 'legacy blob' } };

      const result = mapAcademicInformation(academicRaw, legacyRow);

      expect(result.currentGradeLevel).toBe('class_10');
      expect(result.legacyAcademicMarks).toEqual({ raw: 'legacy blob' });
      expect(result.academicRecords).toEqual([
        {
          academicYear: 'class_10',
          subjects: [
            { subjectName: 'mathematics', score: 88 },
            { subjectName: 'physics', score: 75 },
          ],
        },
      ]);
    });

    it('never merges legacyAcademicMarks into academicRecords[] (field-ownership precedence)', () => {
      const result = mapAcademicInformation({ records: [], subjects: [] }, { grade: 'class_9', academic_marks: 'blob' });
      expect(result.academicRecords).toEqual([]);
      expect(result.legacyAcademicMarks).toBe('blob');
    });

    it('handles null legacy row and empty academic data', () => {
      const result = mapAcademicInformation({ records: [], subjects: [] }, null);
      expect(result).toEqual({ currentGradeLevel: null, academicRecords: [], legacyAcademicMarks: null });
    });
  });

  describe('mapActivities', () => {
    it('maps raw student_activities rows into canonical activityRecords[]', () => {
      const result = mapActivities([
        {
          activity_key: 'debate_club',
          activity_category: 'academic',
          leadership_level: 'captain',
          duration_months: 12,
        },
      ]);

      expect(result.activityRecords).toEqual([
        {
          activityName: 'debate_club',
          activityType: 'academic',
          role: 'captain',
          duration: 12,
          evidenceSource: null,
        },
      ]);
    });

    it('defaults to empty array when no rows exist', () => {
      expect(mapActivities(undefined)).toEqual({ activityRecords: [] });
      expect(mapActivities([])).toEqual({ activityRecords: [] });
    });
  });

  describe('mapAchievements', () => {
    it('maps raw achievement rows, discarding the activity FK linkage', () => {
      const result = mapAchievements([
        {
          student_activity_id: 'activity-123',
          achievement_title: 'State Champion',
          achievement_level: 'state',
          achievement_year: 2025,
        },
      ]);

      expect(result.achievementRecords).toEqual([
        { achievementName: 'State Champion', achievementType: 'state', dateAwarded: 2025, issuingBody: null },
      ]);
      // Confirm no activity back-reference leaks into the canonical shape.
      expect(result.achievementRecords[0]).not.toHaveProperty('activityKey');
      expect(result.achievementRecords[0]).not.toHaveProperty('student_activity_id');
    });

    it('always sets issuingBody to null (no source column exists)', () => {
      const result = mapAchievements([{ achievement_title: 'X', achievement_level: 'y', achievement_year: 2020 }]);
      expect(result.achievementRecords[0].issuingBody).toBeNull();
    });
  });

  describe('mapAssessments', () => {
    it('maps raw cognitive responses, leaving score null (no scored source column)', () => {
      const result = mapAssessments([
        { question_id: 'q-1', selected_option_keys: ['a'], created_at: '2026-01-01T00:00:00.000Z' },
      ]);

      expect(result.cognitiveAssessmentRecords).toEqual([
        { assessmentType: 'q-1', score: null, dateAdministered: '2026-01-01T00:00:00.000Z' },
      ]);
    });

    it('defaults to empty array when no responses exist', () => {
      expect(mapAssessments(undefined)).toEqual({ cognitiveAssessmentRecords: [] });
    });
  });

  describe('mapCareerAspirations', () => {
    it('renames legacy fields directly and passes statedStrengths through unchanged', () => {
      const legacyRow = {
        interests: ['robotics'],
        strengths: { problem_solving: 4, creativity: 3, communication: 5, mathematics: 4, leadership: 2 },
        career_curiosities: ['ai research'],
        learning_styles: ['visual'],
      };

      const result = mapCareerAspirations(legacyRow);

      expect(result.statedInterests).toEqual(['robotics']);
      expect(result.careerCuriosities).toEqual(['ai research']);
      expect(result.learningStyles).toEqual(['visual']);
      // Disclosed type mismatch — object passed through as-is, not coerced.
      expect(result.statedStrengths).toEqual(legacyRow.strengths);
    });

    it('defaults every field to [] when legacyRow is null', () => {
      expect(mapCareerAspirations(null)).toEqual({
        statedInterests: [],
        statedStrengths: [],
        careerCuriosities: [],
        learningStyles: [],
      });
    });
  });
});
