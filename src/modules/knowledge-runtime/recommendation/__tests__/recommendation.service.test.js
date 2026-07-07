'use strict';

/**
 * modules/knowledge-runtime/recommendation/__tests__/recommendation.service.test.js
 *
 * Mocks KnowledgeService and StudentService (per Objective 10: "Mock
 * KnowledgeService, StudentService. Do not mock recommendation logic
 * itself. Verify deterministic outputs.").
 */

const RecommendationService = require('../recommendation.service');

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
  };
}

function makeKnowledgeService(overrides = {}) {
  return {
    searchKnowledge: jest.fn(async () => []),
    listDomains: jest.fn(async () => []),
    ...overrides,
  };
}

function makeStudentService(overrides = {}) {
  return {
    getStudentIntelligenceProfile: jest.fn(async () => ({
      skills: { legacy: [] },
    })),
    ...overrides,
  };
}

describe('RecommendationService', () => {
  describe('constructor', () => {
    it('throws if knowledgeService is missing', () => {
      expect(
        () => new RecommendationService({ studentService: makeStudentService(), logger: makeLogger() })
      ).toThrow('knowledgeService is required');
    });

    it('throws if studentService is missing', () => {
      expect(
        () => new RecommendationService({ knowledgeService: makeKnowledgeService(), logger: makeLogger() })
      ).toThrow('studentService is required');
    });

    it('throws if logger is missing', () => {
      expect(
        () => new RecommendationService({
          knowledgeService: makeKnowledgeService(),
          studentService: makeStudentService(),
        })
      ).toThrow('logger is required');
    });
  });

  describe('generateRecommendationCandidates — capability boundary', () => {
    it('marks all six remaining non-implemented groups as unavailable with a reason, never fabricating candidates', async () => {
      const service = new RecommendationService({
        knowledgeService: makeKnowledgeService(),
        studentService: makeStudentService(),
        cacheClient: makeCacheClient(),
        logger: makeLogger(),
      });

      const result = await service.generateRecommendationCandidates('user-1');

      const unimplementedGroups = [
        'programmeRecommendations',
        'courseRecommendations',
        'scholarshipRecommendations',
        'institutionRecommendations',
        'futureSkillRecommendations',
        'occupationRecommendations',
      ];

      for (const group of unimplementedGroups) {
        expect(result[group].available).toBe(false);
        expect(result[group].candidates).toEqual([]);
        expect(typeof result[group].reason).toBe('string');
        expect(result[group].reason.length).toBeGreaterThan(0);
      }
    });

    it('marks skillRecommendations and careerRecommendations as available (the two implemented rules)', async () => {
      const service = new RecommendationService({
        knowledgeService: makeKnowledgeService(),
        studentService: makeStudentService(),
        cacheClient: makeCacheClient(),
        logger: makeLogger(),
      });

      const result = await service.generateRecommendationCandidates('user-1');

      expect(result.skillRecommendations.available).toBe(true);
      expect(result.skillRecommendations.candidates).toEqual([]);
      expect(result.skillRecommendations.reason).toBeUndefined();
      expect(result.careerRecommendations.available).toBe(true);
      expect(result.careerRecommendations.reason).toBeUndefined();
    });
  });

  describe('skill matching rule — deterministic, no scoring/ranking', () => {
    it('canonicalizes each stated skill via knowledgeService.searchKnowledge', async () => {
      const knowledgeService = makeKnowledgeService({
        searchKnowledge: jest.fn(async (query) => {
          if (query === 'python') {
            return [{ nodeType: 'SKILL', node: { id: 'skill-py', name: 'Python' } }];
          }
          return [];
        }),
      });
      const studentService = makeStudentService({
        getStudentIntelligenceProfile: jest.fn(async () => ({ skills: { legacy: ['python'] } })),
      });
      const service = new RecommendationService({
        knowledgeService,
        studentService,
        cacheClient: makeCacheClient(),
        logger: makeLogger(),
      });

      const result = await service.generateRecommendationCandidates('user-1');

      expect(knowledgeService.searchKnowledge).toHaveBeenCalledWith('python', { nodeTypes: ['SKILL'] });
      expect(result.skillRecommendations.candidates).toEqual([
        { canonicalId: 'skill-py', name: 'Python', nodeType: 'SKILL', matchedFrom: 'python' },
      ]);
    });

    it('deduplicates candidates matched from multiple raw skills by canonical node id', async () => {
      const knowledgeService = makeKnowledgeService({
        searchKnowledge: jest.fn(async () => [{ nodeType: 'SKILL', node: { id: 'skill-js', name: 'JavaScript' } }]),
      });
      const studentService = makeStudentService({
        getStudentIntelligenceProfile: jest.fn(async () => ({ skills: { legacy: ['javascript', 'js'] } })),
      });
      const service = new RecommendationService({
        knowledgeService,
        studentService,
        cacheClient: makeCacheClient(),
        logger: makeLogger(),
      });

      const result = await service.generateRecommendationCandidates('user-1');

      expect(result.skillRecommendations.candidates).toHaveLength(1);
    });

    it('is order-preserving, not scored or ranked — no sort applied to matches', async () => {
      const knowledgeService = makeKnowledgeService({
        searchKnowledge: jest.fn(async () => [
          { nodeType: 'SKILL', node: { id: 'skill-z', name: 'Zebra Skill' } },
          { nodeType: 'SKILL', node: { id: 'skill-a', name: 'Alpha Skill' } },
        ]),
      });
      const studentService = makeStudentService({
        getStudentIntelligenceProfile: jest.fn(async () => ({ skills: { legacy: ['x'] } })),
      });
      const service = new RecommendationService({
        knowledgeService,
        studentService,
        cacheClient: makeCacheClient(),
        logger: makeLogger(),
      });

      const result = await service.generateRecommendationCandidates('user-1');

      expect(result.skillRecommendations.candidates.map((c) => c.canonicalId)).toEqual(['skill-z', 'skill-a']);
    });

    it('does not throw when a skill match fails, and continues with the remaining skills', async () => {
      const knowledgeService = makeKnowledgeService({
        searchKnowledge: jest.fn(async (query) => {
          if (query === 'bad') throw new Error('search failed');
          return [{ nodeType: 'SKILL', node: { id: 'skill-ok', name: 'OK Skill' } }];
        }),
      });
      const studentService = makeStudentService({
        getStudentIntelligenceProfile: jest.fn(async () => ({ skills: { legacy: ['bad', 'good'] } })),
      });
      const logger = makeLogger();
      const service = new RecommendationService({
        knowledgeService,
        studentService,
        cacheClient: makeCacheClient(),
        logger,
      });

      const result = await service.generateRecommendationCandidates('user-1');

      expect(result.skillRecommendations.candidates).toHaveLength(1);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('handles a student profile with no skills gracefully', async () => {
      const service = new RecommendationService({
        knowledgeService: makeKnowledgeService(),
        studentService: makeStudentService({
          getStudentIntelligenceProfile: jest.fn(async () => ({})),
        }),
        cacheClient: makeCacheClient(),
        logger: makeLogger(),
      });

      const result = await service.generateRecommendationCandidates('user-1');

      expect(result.skillRecommendations).toEqual({ available: true, candidates: [] });
    });
  });

  describe('career matching rule (WP-XAI2-04) — deterministic, no scoring/ranking', () => {
    it('canonicalizes each stated career interest via knowledgeService.searchKnowledge against DOMAIN', async () => {
      const knowledgeService = makeKnowledgeService({
        searchKnowledge: jest.fn(async (query) => {
          if (query === 'technology') {
            return [{ nodeType: 'DOMAIN', node: { id: 'domain-tech', name: 'Technology' } }];
          }
          return [];
        }),
      });
      const studentService = makeStudentService({
        getStudentIntelligenceProfile: jest.fn(async () => ({
          skills: { legacy: [] },
          career: {
            interests: { available: true, value: ['technology'] },
            goals: { available: false, value: null },
          },
        })),
      });
      const service = new RecommendationService({
        knowledgeService,
        studentService,
        cacheClient: makeCacheClient(),
        logger: makeLogger(),
      });

      const result = await service.generateRecommendationCandidates('user-1');

      expect(knowledgeService.searchKnowledge).toHaveBeenCalledWith('technology', { nodeTypes: ['DOMAIN'] });
      expect(result.careerRecommendations.candidates).toEqual([
        {
          canonicalId: 'domain-tech',
          name: 'Technology',
          nodeType: 'DOMAIN',
          matchedFrom: 'technology',
          matchStrategy: 'stated-career-interest-or-goal-name-match',
        },
      ]);
    });

    it('also matches on career.goals.value, deduplicating against interests by canonical node id', async () => {
      const knowledgeService = makeKnowledgeService({
        searchKnowledge: jest.fn(async () => [{ nodeType: 'DOMAIN', node: { id: 'domain-tech', name: 'Technology' } }]),
      });
      const studentService = makeStudentService({
        getStudentIntelligenceProfile: jest.fn(async () => ({
          skills: { legacy: [] },
          career: {
            interests: { available: true, value: ['technology'] },
            goals: { available: true, value: ['become a software engineer'] },
          },
        })),
      });
      const service = new RecommendationService({
        knowledgeService,
        studentService,
        cacheClient: makeCacheClient(),
        logger: makeLogger(),
      });

      const result = await service.generateRecommendationCandidates('user-1');

      expect(result.careerRecommendations.candidates).toHaveLength(1);
    });

    it('falls back to knowledgeService.listDomains() when no career interests/goals are stated', async () => {
      const knowledgeService = makeKnowledgeService({
        listDomains: jest.fn(async () => [
          { id: 'domain-1', name: 'Engineering' },
          { id: 'domain-2', name: 'Design' },
        ]),
      });
      const studentService = makeStudentService({
        getStudentIntelligenceProfile: jest.fn(async () => ({
          skills: { legacy: [] },
          career: {
            interests: { available: false, value: null },
            goals: { available: false, value: null },
          },
        })),
      });
      const service = new RecommendationService({
        knowledgeService,
        studentService,
        cacheClient: makeCacheClient(),
        logger: makeLogger(),
      });

      const result = await service.generateRecommendationCandidates('user-1');

      expect(knowledgeService.listDomains).toHaveBeenCalled();
      expect(knowledgeService.searchKnowledge).not.toHaveBeenCalled();
      expect(result.careerRecommendations.available).toBe(true);
      expect(result.careerRecommendations.candidates).toEqual([
        { canonicalId: 'domain-1', name: 'Engineering', nodeType: 'DOMAIN', matchedFrom: null, matchStrategy: 'no-stated-career-interests-or-goals-full-domain-list' },
        { canonicalId: 'domain-2', name: 'Design', nodeType: 'DOMAIN', matchedFrom: null, matchStrategy: 'no-stated-career-interests-or-goals-full-domain-list' },
      ]);
    });

    it('does not throw and marks unavailable when the listDomains() fallback itself fails', async () => {
      const knowledgeService = makeKnowledgeService({
        listDomains: jest.fn(async () => { throw new Error('db down'); }),
      });
      const logger = makeLogger();
      const service = new RecommendationService({
        knowledgeService,
        studentService: makeStudentService(),
        cacheClient: makeCacheClient(),
        logger,
      });

      const result = await service.generateRecommendationCandidates('user-1');

      expect(result.careerRecommendations.available).toBe(false);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('does not throw when a career term match fails, and continues with the remaining terms', async () => {
      const knowledgeService = makeKnowledgeService({
        searchKnowledge: jest.fn(async (query) => {
          if (query === 'bad') throw new Error('search failed');
          return [{ nodeType: 'DOMAIN', node: { id: 'domain-ok', name: 'OK Domain' } }];
        }),
      });
      const studentService = makeStudentService({
        getStudentIntelligenceProfile: jest.fn(async () => ({
          skills: { legacy: [] },
          career: {
            interests: { available: true, value: ['bad', 'good'] },
            goals: { available: false, value: null },
          },
        })),
      });
      const logger = makeLogger();
      const service = new RecommendationService({
        knowledgeService,
        studentService,
        cacheClient: makeCacheClient(),
        logger,
      });

      const result = await service.generateRecommendationCandidates('user-1');

      expect(result.careerRecommendations.candidates).toHaveLength(1);
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('groups filter', () => {
    it('returns only the requested groups as active, others marked skipped', async () => {
      const service = new RecommendationService({
        knowledgeService: makeKnowledgeService(),
        studentService: makeStudentService(),
        cacheClient: makeCacheClient(),
        logger: makeLogger(),
      });

      const result = await service.generateRecommendationCandidates('user-1', { groups: ['skill'] });

      expect(result.skillRecommendations.available).toBe(true);
      expect(result.careerRecommendations.reason).toMatch(/not requested/i);
    });
  });

  describe('caching', () => {
    it('caches the result and returns it on a subsequent call without recomposing', async () => {
      const studentService = makeStudentService();
      const service = new RecommendationService({
        knowledgeService: makeKnowledgeService(),
        studentService,
        cacheClient: makeCacheClient(),
        logger: makeLogger(),
      });

      await service.generateRecommendationCandidates('user-1');
      await service.generateRecommendationCandidates('user-1');

      expect(studentService.getStudentIntelligenceProfile).toHaveBeenCalledTimes(1);
    });

    it('does not throw when cacheClient is null', async () => {
      const service = new RecommendationService({
        knowledgeService: makeKnowledgeService(),
        studentService: makeStudentService(),
        cacheClient: null,
        logger: makeLogger(),
      });

      await expect(service.generateRecommendationCandidates('user-1')).resolves.toBeDefined();
    });
  });

  // WP-IMP-04A Objective 6 — ValidationService quality-gate integration.
  describe('validation quality gate (WP-IMP-04A Objective 6)', () => {
    it('attaches validation: null when no validationServiceResolver is provided (pre-WP-IMP-04A behavior)', async () => {
      const service = new RecommendationService({
        knowledgeService: makeKnowledgeService(),
        studentService: makeStudentService(),
        cacheClient: null,
        logger: makeLogger(),
      });

      const result = await service.generateRecommendationCandidates('user-1');

      expect(result.validation).toBeNull();
    });

    it('attaches the ValidationService result when a resolver is provided', async () => {
      const mockValidationResult = { valid: true, score: 0.9 };
      const mockValidationService = {
        validateRecommendationCandidates: jest.fn(() => mockValidationResult),
      };
      const service = new RecommendationService({
        knowledgeService: makeKnowledgeService(),
        studentService: makeStudentService(),
        cacheClient: null,
        logger: makeLogger(),
        validationServiceResolver: () => mockValidationService,
      });

      const result = await service.generateRecommendationCandidates('user-1');

      expect(mockValidationService.validateRecommendationCandidates).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1' })
      );
      expect(result.validation).toBe(mockValidationResult);
    });

    it('does not change candidate data when the resolver throws — degrades to validation: null', async () => {
      const logger = makeLogger();
      const service = new RecommendationService({
        knowledgeService: makeKnowledgeService(),
        studentService: makeStudentService(),
        cacheClient: null,
        logger,
        validationServiceResolver: () => {
          throw new Error('ValidationService not ready');
        },
      });

      const result = await service.generateRecommendationCandidates('user-1');

      expect(result.validation).toBeNull();
      expect(result.skillRecommendations).toBeDefined();
      expect(logger.warn).toHaveBeenCalled();
    });

    it('does not change candidate data when the resolved service lacks validateRecommendationCandidates', async () => {
      const service = new RecommendationService({
        knowledgeService: makeKnowledgeService(),
        studentService: makeStudentService(),
        cacheClient: null,
        logger: makeLogger(),
        validationServiceResolver: () => ({}),
      });

      const result = await service.generateRecommendationCandidates('user-1');

      expect(result.validation).toBeNull();
    });

    it('the returned response, including the validation field, remains frozen', async () => {
      const service = new RecommendationService({
        knowledgeService: makeKnowledgeService(),
        studentService: makeStudentService(),
        cacheClient: null,
        logger: makeLogger(),
        validationServiceResolver: () => ({
          validateRecommendationCandidates: () => ({ valid: true }),
        }),
      });

      const result = await service.generateRecommendationCandidates('user-1');

      expect(Object.isFrozen(result)).toBe(true);
    });
  });
});
