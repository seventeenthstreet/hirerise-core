'use strict';

/**
 * modules/knowledge-runtime/student/__tests__/studentIntelligence.service.test.js
 *
 * Unit tests for StudentService. Dependencies injected as mocks via the
 * constructor — no jest.mock() of require() paths, per
 * TESTING_STRATEGY.md §1.
 */

const StudentService = require('../studentIntelligence.service');

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeCacheClient({ store = new Map() } = {}) {
  return {
    get: jest.fn(async (key) => store.get(key) ?? null),
    set: jest.fn(async (key, value) => {
      store.set(key, value);
      return 'OK';
    }),
    del: jest.fn(async (key) => {
      store.delete(key);
      return 1;
    }),
  };
}

function makeStudentIntelligenceRepository(overrides = {}) {
  return {
    findLatestSnapshot: jest.fn(async () => null),
    findSnapshotHistory: jest.fn(async () => []),
    insertSnapshot: jest.fn(async () => ({})),
    ...overrides,
  };
}

function makeEducationStudentRepository(overrides = {}) {
  return {
    getStudent: jest.fn(async () => null),
    ...overrides,
  };
}

describe('StudentService', () => {
  describe('constructor', () => {
    it('throws if studentIntelligenceRepository is missing', () => {
      expect(
        () => new StudentService({
          educationStudentRepository: makeEducationStudentRepository(),
          logger: makeLogger(),
        })
      ).toThrow('studentIntelligenceRepository is required');
    });

    it('throws if educationStudentRepository is missing', () => {
      expect(
        () => new StudentService({
          studentIntelligenceRepository: makeStudentIntelligenceRepository(),
          logger: makeLogger(),
        })
      ).toThrow('educationStudentRepository is required');
    });

    it('throws if logger is missing', () => {
      expect(
        () => new StudentService({
          studentIntelligenceRepository: makeStudentIntelligenceRepository(),
          educationStudentRepository: makeEducationStudentRepository(),
        })
      ).toThrow('logger is required');
    });
  });

  describe('getStudentIntelligenceProfile', () => {
    it('composes a full profile shape even with no data sources available', async () => {
      const service = new StudentService({
        studentIntelligenceRepository: makeStudentIntelligenceRepository(),
        educationStudentRepository: makeEducationStudentRepository(),
        cacheClient: makeCacheClient(),
        logger: makeLogger(),
      });

      const result = await service.getStudentIntelligenceProfile('user-1');

      expect(result.userId).toBe('user-1');
      expect(result.personal.available).toBe(false);
      expect(result.academic.stream).toEqual(expect.objectContaining({ available: false }));
      expect(result.skills.legacy).toEqual([]);
      expect(result.readiness.available).toBe(false);
      expect(result.meta.generatedAt).toEqual(expect.any(String));
    });

    it('populates confirmed fields when sources return data', async () => {
      const educationStudentRepository = makeEducationStudentRepository({
        getStudent: jest.fn(async () => ({ name: 'Asha', educationLevel: 'undergraduate', skills: ['python'] })),
      });
      const studentIntelligenceRepository = makeStudentIntelligenceRepository({
        findLatestSnapshot: jest.fn(async () => ({
          compositeConfidence: 72.5,
          confidenceTier: 'MEDIUM',
          dataCompleteness: 0.6,
          activeSignalCount: 12,
          domainsIncluded: ['academic', 'activity'],
          snapshotAt: '2026-06-01T00:00:00.000Z',
          signalState: { foo: 1 },
          domainState: { academic: { score: 0.7 } },
        })),
      });
      const service = new StudentService({
        studentIntelligenceRepository,
        educationStudentRepository,
        cacheClient: makeCacheClient(),
        logger: makeLogger(),
      });

      const result = await service.getStudentIntelligenceProfile('user-1');

      expect(result.personal).toEqual(expect.objectContaining({ available: true, name: 'Asha' }));
      expect(result.academic.educationLevelLegacy).toBe('undergraduate');
      expect(result.skills.legacy).toEqual(['python']);
      expect(result.readiness).toEqual(expect.objectContaining({
        available: true,
        compositeConfidence: 72.5,
        confidenceTier: 'MEDIUM',
      }));
    });

    it('does not throw when a composition source fails', async () => {
      const educationStudentRepository = makeEducationStudentRepository({
        getStudent: jest.fn(async () => { throw new Error('db down'); }),
      });
      const logger = makeLogger();
      const service = new StudentService({
        studentIntelligenceRepository: makeStudentIntelligenceRepository(),
        educationStudentRepository,
        cacheClient: makeCacheClient(),
        logger,
      });

      const result = await service.getStudentIntelligenceProfile('user-1');

      expect(result.personal.available).toBe(false);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('returns the cached value without recomposing on a cache hit', async () => {
      const cached = { userId: 'user-1', personal: { available: true, name: 'Cached' } };
      const store = new Map();
      store.set('student-runtime:profile:user-1', JSON.stringify(cached));

      const educationStudentRepository = makeEducationStudentRepository();
      const service = new StudentService({
        studentIntelligenceRepository: makeStudentIntelligenceRepository(),
        educationStudentRepository,
        cacheClient: makeCacheClient({ store }),
        logger: makeLogger(),
      });

      const result = await service.getStudentIntelligenceProfile('user-1');

      expect(result).toEqual(cached);
      expect(educationStudentRepository.getStudent).not.toHaveBeenCalled();
    });
  });

  describe('career composition (WP-XAI2-04)', () => {
    function makeCareerProfileService(overrides = {}) {
      return { getCareerProfile: jest.fn(async () => null), ...overrides };
    }

    function makeProfessionalCareerProfileRepository(overrides = {}) {
      return { getProfessionalCareerProfile: jest.fn(async () => null), ...overrides };
    }

    it('falls back to notSourced() for career.interests/goals when neither source is wired in', async () => {
      const service = new StudentService({
        studentIntelligenceRepository: makeStudentIntelligenceRepository(),
        educationStudentRepository: makeEducationStudentRepository(),
        cacheClient: makeCacheClient(),
        logger: makeLogger(),
      });

      const result = await service.getStudentIntelligenceProfile('user-1');

      expect(result.career.interests).toEqual(expect.objectContaining({ available: false, value: null }));
      expect(result.career.goals).toEqual(expect.objectContaining({ available: false, value: null }));
    });

    it('sources career.interests from student_career_profiles via careerProfileService', async () => {
      const careerProfileService = makeCareerProfileService({
        getCareerProfile: jest.fn(async () => ({
          interests: ['technology', 'design'],
          careerCuriosities: ['software engineer'],
        })),
      });
      const service = new StudentService({
        studentIntelligenceRepository: makeStudentIntelligenceRepository(),
        educationStudentRepository: makeEducationStudentRepository(),
        careerProfileService,
        cacheClient: makeCacheClient(),
        logger: makeLogger(),
      });

      const result = await service.getStudentIntelligenceProfile('user-1');

      expect(careerProfileService.getCareerProfile).toHaveBeenCalledWith('user-1');
      expect(result.career.interests).toEqual({
        available: true,
        value: ['technology', 'design'],
        curiosities: ['software engineer'],
        source: 'student_career_profiles.interests/career_curiosities (student-onboarding track)',
      });
    });

    it('prefers the structured career_goals array over the single career_goal text when both exist', async () => {
      const professionalCareerProfileRepository = makeProfessionalCareerProfileRepository({
        getProfessionalCareerProfile: jest.fn(async () => ({
          careerGoal: 'Become a senior engineer',
          careerGoals: ['switch to product management'],
        })),
      });
      const service = new StudentService({
        studentIntelligenceRepository: makeStudentIntelligenceRepository(),
        educationStudentRepository: makeEducationStudentRepository(),
        professionalCareerProfileRepository,
        cacheClient: makeCacheClient(),
        logger: makeLogger(),
      });

      const result = await service.getStudentIntelligenceProfile('user-1');

      expect(result.career.goals).toEqual(expect.objectContaining({
        available: true,
        value: ['switch to product management'],
        source: expect.stringContaining('user_profiles.data.career_goals'),
      }));
    });

    it('falls back to the single career_goal text when career_goals is empty', async () => {
      const professionalCareerProfileRepository = makeProfessionalCareerProfileRepository({
        getProfessionalCareerProfile: jest.fn(async () => ({
          careerGoal: 'Become a senior engineer',
          careerGoals: [],
        })),
      });
      const service = new StudentService({
        studentIntelligenceRepository: makeStudentIntelligenceRepository(),
        educationStudentRepository: makeEducationStudentRepository(),
        professionalCareerProfileRepository,
        cacheClient: makeCacheClient(),
        logger: makeLogger(),
      });

      const result = await service.getStudentIntelligenceProfile('user-1');

      expect(result.career.goals).toEqual(expect.objectContaining({
        available: true,
        value: ['Become a senior engineer'],
        source: expect.stringContaining('users.career_goal'),
      }));
    });

    it('does not throw and falls back to notSourced() when a career source fails', async () => {
      const careerProfileService = makeCareerProfileService({
        getCareerProfile: jest.fn(async () => { throw new Error('db down'); }),
      });
      const logger = makeLogger();
      const service = new StudentService({
        studentIntelligenceRepository: makeStudentIntelligenceRepository(),
        educationStudentRepository: makeEducationStudentRepository(),
        careerProfileService,
        cacheClient: makeCacheClient(),
        logger,
      });

      const result = await service.getStudentIntelligenceProfile('user-1');

      expect(result.career.interests.available).toBe(false);
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('refreshFromOnboarding', () => {
    it('invalidates the cache and recomposes rather than computing a new snapshot', async () => {
      const store = new Map();
      store.set('student-runtime:profile:user-1', JSON.stringify({ stale: true }));

      const studentIntelligenceRepository = makeStudentIntelligenceRepository();
      const service = new StudentService({
        studentIntelligenceRepository,
        educationStudentRepository: makeEducationStudentRepository(),
        cacheClient: makeCacheClient({ store }),
        logger: makeLogger(),
      });

      const result = await service.refreshFromOnboarding('user-1');

      expect(result.stale).toBeUndefined();
      expect(studentIntelligenceRepository.insertSnapshot).not.toHaveBeenCalled();
    });
  });

  describe('getReadinessScore', () => {
    it('returns null when no snapshot exists', async () => {
      const service = new StudentService({
        studentIntelligenceRepository: makeStudentIntelligenceRepository(),
        educationStudentRepository: makeEducationStudentRepository(),
        logger: makeLogger(),
      });

      await expect(service.getReadinessScore('user-1')).resolves.toBeNull();
    });

    it('returns compositeConfidence from the latest snapshot', async () => {
      const studentIntelligenceRepository = makeStudentIntelligenceRepository({
        findLatestSnapshot: jest.fn(async () => ({ compositeConfidence: 55 })),
      });
      const service = new StudentService({
        studentIntelligenceRepository,
        educationStudentRepository: makeEducationStudentRepository(),
        logger: makeLogger(),
      });

      await expect(service.getReadinessScore('user-1')).resolves.toBe(55);
    });
  });

  describe('getProfileVector', () => {
    it('returns null when no snapshot exists', async () => {
      const service = new StudentService({
        studentIntelligenceRepository: makeStudentIntelligenceRepository(),
        educationStudentRepository: makeEducationStudentRepository(),
        logger: makeLogger(),
      });

      await expect(service.getProfileVector('user-1')).resolves.toBeNull();
    });

    it('returns signalState/domainState verbatim from the latest snapshot', async () => {
      const studentIntelligenceRepository = makeStudentIntelligenceRepository({
        findLatestSnapshot: jest.fn(async () => ({
          signalState: { a: 1 },
          domainState: { b: 2 },
        })),
      });
      const service = new StudentService({
        studentIntelligenceRepository,
        educationStudentRepository: makeEducationStudentRepository(),
        logger: makeLogger(),
      });

      await expect(service.getProfileVector('user-1')).resolves.toEqual({
        signalState: { a: 1 },
        domainState: { b: 2 },
      });
    });
  });

  describe('snapshot slice methods', () => {
    it('getAcademicSnapshot returns only userId/academic/meta', async () => {
      const service = new StudentService({
        studentIntelligenceRepository: makeStudentIntelligenceRepository(),
        educationStudentRepository: makeEducationStudentRepository(),
        cacheClient: makeCacheClient(),
        logger: makeLogger(),
      });

      const result = await service.getAcademicSnapshot('user-1');

      expect(Object.keys(result).sort()).toEqual(['academic', 'meta', 'userId']);
    });

    it('getFutureSnapshot returns goals + readiness', async () => {
      const service = new StudentService({
        studentIntelligenceRepository: makeStudentIntelligenceRepository(),
        educationStudentRepository: makeEducationStudentRepository(),
        cacheClient: makeCacheClient(),
        logger: makeLogger(),
      });

      const result = await service.getFutureSnapshot('user-1');

      expect(Object.keys(result).sort()).toEqual(['goals', 'meta', 'readiness', 'userId']);
    });

    it('getStudentSnapshot is an alias for the full profile', async () => {
      const service = new StudentService({
        studentIntelligenceRepository: makeStudentIntelligenceRepository(),
        educationStudentRepository: makeEducationStudentRepository(),
        cacheClient: makeCacheClient(),
        logger: makeLogger(),
      });

      const full = await service.getStudentIntelligenceProfile('user-1');
      const snapshot = await service.getStudentSnapshot('user-1');

      expect(snapshot).toEqual(full);
    });
  });
});
