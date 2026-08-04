'use strict';

/**
 * __tests__/studentProfile.repository.test.js
 *
 * Unit tests for the repository's public interface. The aggregate builder
 * is mocked — this file exercises only getStudentProfile()'s error
 * translation/logging and getStudentProfileSubdomain()'s slicing/
 * validation, per the work package's "Mock existing repositories" rule.
 */

describe('studentProfile.repository', () => {
  let getStudentProfile;
  let getStudentProfileSubdomain;
  let writeAcademicInformation;
  let writeActivities;
  let writeAchievement;
  let deleteAchievement;
  let writeAssessments;
  let writeCareerAspirations;
  let buildStudentProfileMock;
  let mutationBuilderMock;
  let loggerMock;

  const fullProfile = {
    studentId: 's-1',
    schemaContractVersion: 1,
    createdAt: null,
    updatedAt: null,
    sourceSystemProvenance: [],
    academicInformation: { currentGradeLevel: null, academicRecords: [], legacyAcademicMarks: null },
    activities: { activityRecords: [] },
    achievements: { achievementRecords: [] },
    assessments: { cognitiveAssessmentRecords: [] },
    careerAspirations: { statedInterests: [], statedStrengths: [], careerCuriosities: [], learningStyles: [] },
  };

  beforeEach(() => {
    jest.resetModules();

    buildStudentProfileMock = jest.fn();
    loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    mutationBuilderMock = {
      writeAcademicInformation: jest.fn(),
      writeActivities: jest.fn(),
      writeAchievement: jest.fn(),
      deleteAchievement: jest.fn(),
      writeAssessments: jest.fn(),
      writeCareerAspirations: jest.fn(),
    };

    jest.doMock('../studentProfile.aggregateBuilder', () => ({
      buildStudentProfile: buildStudentProfileMock,
    }));
    jest.doMock('../studentProfile.mutationBuilder', () => mutationBuilderMock);
    jest.doMock('../../../utils/logger', () => loggerMock);

    ({
      getStudentProfile,
      getStudentProfileSubdomain,
      writeAcademicInformation,
      writeActivities,
      writeAchievement,
      deleteAchievement,
      writeAssessments,
      writeCareerAspirations,
    } = require('../studentProfile.repository'));
  });

  describe('getStudentProfile', () => {
    it('returns whatever the aggregate builder resolves', async () => {
      buildStudentProfileMock.mockResolvedValue(fullProfile);
      const result = await getStudentProfile('s-1');
      expect(result).toBe(fullProfile);
      expect(buildStudentProfileMock).toHaveBeenCalledWith('s-1');
    });

    it('returns null for a student with no data, without logging an error', async () => {
      buildStudentProfileMock.mockResolvedValue(null);
      const result = await getStudentProfile('s-empty');
      expect(result).toBeNull();
      expect(loggerMock.error).not.toHaveBeenCalled();
    });

    it('logs and rethrows a RepositoryLoadError', async () => {
      const { RepositoryLoadError } = require('../studentProfile.errors');
      const error = new RepositoryLoadError('assessments', new Error('boom'));
      buildStudentProfileMock.mockRejectedValue(error);

      await expect(getStudentProfile('s-1')).rejects.toBe(error);
      expect(loggerMock.error).toHaveBeenCalledWith(
        '[StudentProfileRepository] getStudentProfile: subdomain load failed',
        expect.objectContaining({ studentId: 's-1', subdomain: 'assessments' }),
      );
    });
  });

  describe('getStudentProfileSubdomain', () => {
    it('returns just the requested subdomain slice', async () => {
      buildStudentProfileMock.mockResolvedValue(fullProfile);
      const result = await getStudentProfileSubdomain('s-1', 'assessments');
      expect(result).toBe(fullProfile.assessments);
    });

    it('returns null when the student has no profile data at all', async () => {
      buildStudentProfileMock.mockResolvedValue(null);
      const result = await getStudentProfileSubdomain('s-empty', 'assessments');
      expect(result).toBeNull();
    });

    it('throws ValidationError for an unrecognized subdomain key, without calling the builder', async () => {
      await expect(getStudentProfileSubdomain('s-1', 'notARealSubdomain')).rejects.toMatchObject({
        name: 'ValidationError',
      });
      expect(buildStudentProfileMock).not.toHaveBeenCalled();
    });

    it('only performs one reconciliation pass (delegates to getStudentProfile, not a second pipeline)', async () => {
      buildStudentProfileMock.mockResolvedValue(fullProfile);
      await getStudentProfileSubdomain('s-1', 'activities');
      expect(buildStudentProfileMock).toHaveBeenCalledTimes(1);
    });
  });

  // ── Write methods (WP-STD-IMP-03B) ──────────────────────────────────────

  describe('writeAcademicInformation', () => {
    it('delegates to the mutation builder and returns its result', async () => {
      mutationBuilderMock.writeAcademicInformation.mockResolvedValue({ written: true, fields: ['academicRecords'] });
      const result = await writeAcademicInformation('s-1', { academicRecords: [] });
      expect(mutationBuilderMock.writeAcademicInformation).toHaveBeenCalledWith('s-1', { academicRecords: [] });
      expect(result).toEqual({ written: true, fields: ['academicRecords'] });
    });

    it('logs and rethrows on failure', async () => {
      const { PersistenceError } = require('../studentProfile.errors');
      const error = new PersistenceError('no adapter');
      mutationBuilderMock.writeAcademicInformation.mockRejectedValue(error);

      await expect(writeAcademicInformation('s-1', {})).rejects.toBe(error);
      expect(loggerMock.error).toHaveBeenCalledWith(
        '[StudentProfileRepository] writeAcademicInformation: persistence failed',
        expect.objectContaining({ studentId: 's-1' }),
      );
    });
  });

  describe('writeActivities', () => {
    it('delegates to the mutation builder', async () => {
      mutationBuilderMock.writeActivities.mockResolvedValue({ written: true, fields: ['activityRecords'] });
      const result = await writeActivities('s-1', { activityRecords: [] });
      expect(mutationBuilderMock.writeActivities).toHaveBeenCalledWith('s-1', { activityRecords: [] });
      expect(result).toEqual({ written: true, fields: ['activityRecords'] });
    });
  });

  describe('writeAchievement', () => {
    it('delegates to the mutation builder with activityKey', async () => {
      mutationBuilderMock.writeAchievement.mockResolvedValue({ written: true, achievementId: 'a-1' });
      const achievement = { achievementName: 'x', achievementType: 'y' };
      const result = await writeAchievement('s-1', 'activity-key', achievement);
      expect(mutationBuilderMock.writeAchievement).toHaveBeenCalledWith('s-1', 'activity-key', achievement);
      expect(result).toEqual({ written: true, achievementId: 'a-1' });
    });

    it('logs and rethrows a MutationError', async () => {
      const { MutationError } = require('../studentProfile.errors');
      const error = new MutationError('bad activityKey');
      mutationBuilderMock.writeAchievement.mockRejectedValue(error);

      await expect(writeAchievement('s-1', 'bad-key', {})).rejects.toBe(error);
      expect(loggerMock.error).toHaveBeenCalledWith(
        '[StudentProfileRepository] writeAchievement: rejected',
        expect.objectContaining({ studentId: 's-1' }),
      );
    });
  });

  describe('deleteAchievement', () => {
    it('delegates to the mutation builder', async () => {
      mutationBuilderMock.deleteAchievement.mockResolvedValue({ deleted: true });
      const result = await deleteAchievement('s-1', 'achievement-1');
      expect(mutationBuilderMock.deleteAchievement).toHaveBeenCalledWith('s-1', 'achievement-1');
      expect(result).toEqual({ deleted: true });
    });
  });

  describe('writeAssessments', () => {
    it('delegates to the mutation builder', async () => {
      mutationBuilderMock.writeAssessments.mockResolvedValue({ written: true, fields: ['cognitiveAssessmentRecords'] });
      const result = await writeAssessments('s-1', { cognitiveAssessmentRecords: [] });
      expect(mutationBuilderMock.writeAssessments).toHaveBeenCalledWith('s-1', { cognitiveAssessmentRecords: [] });
      expect(result).toEqual({ written: true, fields: ['cognitiveAssessmentRecords'] });
    });
  });

  describe('writeCareerAspirations', () => {
    it('delegates to the mutation builder and propagates its rejection', async () => {
      const { PersistenceError } = require('../studentProfile.errors');
      const error = new PersistenceError('no write adapter exists for Career Aspirations');
      mutationBuilderMock.writeCareerAspirations.mockRejectedValue(error);

      await expect(writeCareerAspirations('s-1', { statedInterests: ['music'] })).rejects.toBe(error);
      expect(mutationBuilderMock.writeCareerAspirations).toHaveBeenCalledWith('s-1', { statedInterests: ['music'] });
    });
  });
});
