'use strict';

/**
 * __tests__/studentProfile.mutationBuilder.test.js
 *
 * Unit tests for the Mutation Builder, per the work package's Testing
 * requirement: mock all repositories, no live database, no integration
 * tests. Covers successful writes, validation failures, repository
 * delegation, partial failure handling, and error propagation.
 */

describe('studentProfile.mutationBuilder', () => {
  let mutationBuilder;
  let academicRepository;
  let activityRepository;
  let cognitiveRepository;

  beforeEach(() => {
    jest.resetModules();

    jest.doMock('../../../config/supabase', () => ({ supabase: {} }));
    jest.doMock('../../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

    jest.doMock('../../../modules/student-onboarding/repositories/academic.repository', () => ({
      upsertAcademicRecord: jest.fn(),
      upsertAcademicSubjects: jest.fn(),
    }));
    jest.doMock('../../../modules/student-onboarding/repositories/activity.repository', () => ({
      fetchStudentActivityData: jest.fn(),
      upsertStudentActivity: jest.fn(),
      insertAchievement: jest.fn(),
      deleteAchievement: jest.fn(),
    }));
    jest.doMock('../../../modules/student-onboarding/repositories/cognitive.repository', () => ({
      batchUpsertCognitiveResponses: jest.fn(),
    }));

    mutationBuilder = require('../studentProfile.mutationBuilder');
    academicRepository = require('../../../modules/student-onboarding/repositories/academic.repository');
    activityRepository = require('../../../modules/student-onboarding/repositories/activity.repository');
    cognitiveRepository = require('../../../modules/student-onboarding/repositories/cognitive.repository');
  });

  describe('writeAcademicInformation', () => {
    it('delegates academicRecords[] to academic.repository.js', async () => {
      academicRepository.upsertAcademicRecord.mockResolvedValue({ id: 'rec-1' });
      academicRepository.upsertAcademicSubjects.mockResolvedValue([]);

      const result = await mutationBuilder.writeAcademicInformation('student-1', {
        academicRecords: [{ academicYear: 'class_10', subjects: [{ subjectName: 'physics', score: 90 }] }],
      });

      expect(academicRepository.upsertAcademicRecord).toHaveBeenCalledWith(
        {},
        { user_id: 'student-1', academic_year: 'class_10' },
      );
      expect(academicRepository.upsertAcademicSubjects).toHaveBeenCalledWith(
        {},
        'student-1',
        'class_10',
        'rec-1',
        [{ subject: 'physics', marks_obtained: 90 }],
      );
      expect(result).toEqual({ written: true, fields: ['academicRecords'] });
    });

    it('rejects with PersistenceError when currentGradeLevel is present, without calling any adapter', async () => {
      await expect(
        mutationBuilder.writeAcademicInformation('student-1', { currentGradeLevel: 'class_11', academicRecords: [] }),
      ).rejects.toMatchObject({ name: 'PersistenceError' });

      expect(academicRepository.upsertAcademicRecord).not.toHaveBeenCalled();
    });

    it('rejects with MutationError on a structurally invalid payload', async () => {
      await expect(mutationBuilder.writeAcademicInformation('student-1', { academicRecords: 'not-an-array' })).rejects.toMatchObject({
        name: 'MutationError',
      });
      expect(academicRepository.upsertAcademicRecord).not.toHaveBeenCalled();
    });

    it('returns written:false for an empty partial (no-op, not an error)', async () => {
      const result = await mutationBuilder.writeAcademicInformation('student-1', {});
      expect(result).toEqual({ written: false, fields: [] });
      expect(academicRepository.upsertAcademicRecord).not.toHaveBeenCalled();
    });

    it('propagates adapter failures as PersistenceError', async () => {
      academicRepository.upsertAcademicRecord.mockRejectedValue(new Error('db down'));

      await expect(
        mutationBuilder.writeAcademicInformation('student-1', {
          academicRecords: [{ academicYear: 'class_10', subjects: [] }],
        }),
      ).rejects.toMatchObject({ name: 'PersistenceError' });
    });
  });

  describe('writeActivities', () => {
    it('delegates each activity to activity.repository.js', async () => {
      activityRepository.upsertStudentActivity.mockResolvedValue({ id: 'act-1' });

      const result = await mutationBuilder.writeActivities('student-1', {
        activityRecords: [{ activityName: 'robotics_club', activityType: 'stem', role: 'captain', duration: 6 }],
      });

      expect(activityRepository.upsertStudentActivity).toHaveBeenCalledWith(
        {},
        {
          user_id: 'student-1',
          activity_key: 'robotics_club',
          activity_category: 'stem',
          leadership_level: 'captain',
          duration_months: 6,
        },
      );
      expect(result).toEqual({ written: true, fields: ['activityRecords'] });
    });

    it('rejects with MutationError on a structurally invalid payload', async () => {
      await expect(mutationBuilder.writeActivities('student-1', { activityRecords: [{ activityType: 'stem' }] })).rejects.toMatchObject({
        name: 'MutationError',
      });
      expect(activityRepository.upsertStudentActivity).not.toHaveBeenCalled();
    });

    it('propagates adapter failures as PersistenceError', async () => {
      activityRepository.upsertStudentActivity.mockRejectedValue(new Error('conflict'));
      await expect(
        mutationBuilder.writeActivities('student-1', { activityRecords: [{ activityName: 'x', activityType: 'y' }] }),
      ).rejects.toMatchObject({ name: 'PersistenceError' });
    });
  });

  describe('writeAchievement', () => {
    it('resolves activityKey then delegates to insertAchievement', async () => {
      activityRepository.fetchStudentActivityData.mockResolvedValue({
        activities: [{ id: 'act-uuid-1', activity_key: 'robotics_club' }],
        achievements: [],
        reflection: null,
      });
      activityRepository.insertAchievement.mockResolvedValue({ id: 'achievement-uuid-1' });

      const result = await mutationBuilder.writeAchievement('student-1', 'robotics_club', {
        achievementName: 'Regional Finalist',
        achievementType: 'regional',
        dateAwarded: 2025,
      });

      expect(activityRepository.insertAchievement).toHaveBeenCalledWith(
        {},
        {
          user_id: 'student-1',
          student_activity_id: 'act-uuid-1',
          achievement_title: 'Regional Finalist',
          achievement_level: 'regional',
          achievement_year: 2025,
        },
      );
      expect(result).toEqual({ written: true, achievementId: 'achievement-uuid-1' });
    });

    it('rejects with MutationError when activityKey has no matching activity (real FK constraint)', async () => {
      activityRepository.fetchStudentActivityData.mockResolvedValue({ activities: [], achievements: [], reflection: null });

      await expect(
        mutationBuilder.writeAchievement('student-1', 'nonexistent_activity', {
          achievementName: 'X',
          achievementType: 'y',
        }),
      ).rejects.toMatchObject({ name: 'MutationError' });
      expect(activityRepository.insertAchievement).not.toHaveBeenCalled();
    });

    it('rejects with MutationError on a structurally invalid payload without ever calling fetch', async () => {
      await expect(mutationBuilder.writeAchievement('student-1', '', { achievementName: 'x', achievementType: 'y' })).rejects.toMatchObject(
        { name: 'MutationError' },
      );
      expect(activityRepository.fetchStudentActivityData).not.toHaveBeenCalled();
    });
  });

  describe('deleteAchievement', () => {
    it('delegates to activity.repository.js', async () => {
      activityRepository.deleteAchievement.mockResolvedValue(undefined);
      const result = await mutationBuilder.deleteAchievement('student-1', 'achievement-1');
      expect(activityRepository.deleteAchievement).toHaveBeenCalledWith({}, 'student-1', 'achievement-1');
      expect(result).toEqual({ deleted: true });
    });

    it('rejects with MutationError on a missing achievementId', async () => {
      await expect(mutationBuilder.deleteAchievement('student-1', '')).rejects.toMatchObject({ name: 'MutationError' });
      expect(activityRepository.deleteAchievement).not.toHaveBeenCalled();
    });

    it('propagates adapter failures as PersistenceError', async () => {
      activityRepository.deleteAchievement.mockRejectedValue(new Error('boom'));
      await expect(mutationBuilder.deleteAchievement('student-1', 'achievement-1')).rejects.toMatchObject({
        name: 'PersistenceError',
      });
    });
  });

  describe('writeAssessments', () => {
    it('delegates to cognitive.repository.js batch upsert', async () => {
      cognitiveRepository.batchUpsertCognitiveResponses.mockResolvedValue([]);

      const result = await mutationBuilder.writeAssessments('student-1', {
        cognitiveAssessmentRecords: [{ assessmentType: 'question-uuid-1', selectedOptionKeys: ['a', 'b'] }],
      });

      expect(cognitiveRepository.batchUpsertCognitiveResponses).toHaveBeenCalledWith({}, 'student-1', [
        { question_id: 'question-uuid-1', selected_option_keys: ['a', 'b'], is_partial: undefined },
      ]);
      expect(result).toEqual({ written: true, fields: ['cognitiveAssessmentRecords'] });
    });

    it('rejects with MutationError when selectedOptionKeys is missing', async () => {
      await expect(
        mutationBuilder.writeAssessments('student-1', { cognitiveAssessmentRecords: [{ assessmentType: 'q-1' }] }),
      ).rejects.toMatchObject({ name: 'MutationError' });
      expect(cognitiveRepository.batchUpsertCognitiveResponses).not.toHaveBeenCalled();
    });

    it('propagates adapter failures as PersistenceError', async () => {
      cognitiveRepository.batchUpsertCognitiveResponses.mockRejectedValue(new Error('boom'));
      await expect(
        mutationBuilder.writeAssessments('student-1', {
          cognitiveAssessmentRecords: [{ assessmentType: 'q-1', selectedOptionKeys: ['a'] }],
        }),
      ).rejects.toMatchObject({ name: 'PersistenceError' });
    });
  });

  describe('writeCareerAspirations', () => {
    it('always rejects with PersistenceError for a structurally valid payload (no write adapter exists)', async () => {
      await expect(
        mutationBuilder.writeCareerAspirations('student-1', { statedInterests: ['music'] }),
      ).rejects.toMatchObject({ name: 'PersistenceError' });
    });

    it('rejects with MutationError first, for a structurally invalid payload', async () => {
      await expect(mutationBuilder.writeCareerAspirations('student-1', { statedInterests: 'not-an-array' })).rejects.toMatchObject({
        name: 'MutationError',
      });
    });
  });
});
