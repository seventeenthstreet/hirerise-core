'use strict';

/**
 * modules/knowledge-runtime/validation/__tests__/validation.service.test.js
 *
 * Mocks KnowledgeService, StudentService, RecommendationService, and the
 * IQF qualityService — ValidationService's own logic (the checks) is real,
 * unmocked, per Objective 9.
 */

const ValidationService = require('../validation.service');

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
  return { searchKnowledge: jest.fn(async () => []), ...overrides };
}

function makeCompleteStudentContext(overrides = {}) {
  return {
    userId: 'user-1',
    personal: { available: true, name: 'Test Student' },
    academic: { available: true, educationLevel: 'UG', stream: { available: false, value: null, note: 'not sourced' } },
    career: { interests: { available: false, value: null, note: 'not sourced' }, goals: { available: false, value: null, note: 'not sourced' } },
    skills: { legacy: ['Python'], structured: { available: false, value: null, note: 'not sourced' } },
    experience: { available: false, value: null, note: 'not sourced' },
    preferences: { available: false, value: null, note: 'not sourced' },
    readiness: { available: true, compositeConfidence: 0.75, confidenceTier: 'medium' },
    meta: { generatedAt: '2026-01-01T00:00:00.000Z' },
    ...overrides,
  };
}

function makeStudentService(overrides = {}) {
  return {
    getStudentIntelligenceProfile: jest.fn(async () => makeCompleteStudentContext()),
    ...overrides,
  };
}

function makeCompleteCandidatesResponse(overrides = {}) {
  return {
    userId: 'user-1',
    skillRecommendations: {
      available: true,
      candidates: [{ canonicalId: 'skill-1', name: 'Python', nodeType: 'SKILL', matchedFrom: 'Python' }],
    },
    careerRecommendations: { available: false, candidates: [], reason: 'not available' },
    programmeRecommendations: { available: false, candidates: [], reason: 'not available' },
    courseRecommendations: { available: false, candidates: [], reason: 'not available' },
    scholarshipRecommendations: { available: false, candidates: [], reason: 'not available' },
    institutionRecommendations: { available: false, candidates: [], reason: 'not available' },
    futureSkillRecommendations: { available: false, candidates: [], reason: 'not available' },
    occupationRecommendations: { available: false, candidates: [], reason: 'not available' },
    meta: { generatedAt: '2026-01-01T00:00:00.000Z', pipeline: 'deterministic-rule-matching-v1' },
    ...overrides,
  };
}

function makeCareerCandidatesResponse(overrides = {}) {
  return makeCompleteCandidatesResponse({
    careerRecommendations: {
      available: true,
      candidates: [{ canonicalId: 'domain-1', name: 'Data Science', nodeType: 'DOMAIN', matchedFrom: 'Data Science' }],
    },
    ...overrides,
  });
}

function makeRecommendationService(overrides = {}) {
  return {
    generateRecommendationCandidates: jest.fn(async () => makeCompleteCandidatesResponse()),
    ...overrides,
  };
}

function makeQualityService(overrides = {}) {
  return {
    getQualityReport: jest.fn(async () => ({ coverage: null, reliability: [], stability: [], drift: null })),
    ...overrides,
  };
}

function makeService(overrides = {}) {
  return new ValidationService({
    knowledgeService: makeKnowledgeService(),
    studentService: makeStudentService(),
    recommendationService: makeRecommendationService(),
    qualityService: makeQualityService(),
    logger: makeLogger(),
    cacheClient: null,
    ...overrides,
  });
}

describe('ValidationService', () => {
  describe('constructor', () => {
    it('throws if knowledgeService is missing', () => {
      expect(
        () =>
          new ValidationService({
            studentService: makeStudentService(),
            recommendationService: makeRecommendationService(),
            logger: makeLogger(),
          })
      ).toThrow('knowledgeService is required');
    });

    it('throws if studentService is missing', () => {
      expect(
        () =>
          new ValidationService({
            knowledgeService: makeKnowledgeService(),
            recommendationService: makeRecommendationService(),
            logger: makeLogger(),
          })
      ).toThrow('studentService is required');
    });

    it('throws if recommendationService is missing', () => {
      expect(
        () =>
          new ValidationService({
            knowledgeService: makeKnowledgeService(),
            studentService: makeStudentService(),
            logger: makeLogger(),
          })
      ).toThrow('recommendationService is required');
    });

    it('throws if logger is missing', () => {
      expect(
        () =>
          new ValidationService({
            knowledgeService: makeKnowledgeService(),
            studentService: makeStudentService(),
            recommendationService: makeRecommendationService(),
          })
      ).toThrow('logger is required');
    });

    it('does not require qualityService (IQF is best-effort)', () => {
      expect(() => makeService({ qualityService: null })).not.toThrow();
    });
  });

  describe('validateStudentContext', () => {
    it('flags a missing context as an error', () => {
      const service = makeService();
      const result = service.validateStudentContext(null);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('STUDENT_CONTEXT_MISSING');
    });

    it('flags a context without a userId as an error', () => {
      const service = makeService();
      const ctx = makeCompleteStudentContext({ userId: undefined });
      const result = service.validateStudentContext(ctx);
      expect(result.errors).toContain('STUDENT_CONTEXT_MISSING_USER_ID');
    });

    it('collects not-sourced fields as missingData/warnings without erroring', () => {
      const service = makeService();
      const result = service.validateStudentContext(makeCompleteStudentContext());
      expect(result.valid).toBe(true);
      expect(result.missingData.some((m) => m.path === 'academic.stream')).toBe(true);
      expect(result.warnings).toContain('NOT_SOURCED:academic.stream');
    });
  });

  describe('validateCompleteness', () => {
    it('scores 1.0 when all confirmed dimensions are available', () => {
      const service = makeService();
      const result = service.validateCompleteness(makeCompleteStudentContext());
      expect(result.score).toBe(1);
      expect(result.qualityFlags).toEqual([]);
    });

    it('flags LOW_STUDENT_PROFILE_COMPLETENESS when fewer than half the dimensions are available', () => {
      const service = makeService();
      const ctx = makeCompleteStudentContext({
        personal: { available: false },
        academic: { available: false },
        skills: { legacy: [] },
      });
      const result = service.validateCompleteness(ctx);
      expect(result.score).toBeLessThan(0.5);
      expect(result.qualityFlags).toContain('LOW_STUDENT_PROFILE_COMPLETENESS');
    });
  });

  describe('validateConfidence', () => {
    it('warns (not errors) when confidence is unavailable', () => {
      const service = makeService();
      const result = service.validateConfidence(null);
      expect(result.valid).toBe(false);
      expect(result.warnings).toContain('CONFIDENCE_UNAVAILABLE');
      expect(result.errors).toEqual([]);
    });

    it('errors on a non-numeric value', () => {
      const service = makeService();
      const result = service.validateConfidence('high');
      expect(result.errors).toContain('CONFIDENCE_NOT_NUMERIC');
    });

    it('errors when out of the [0,1] range', () => {
      const service = makeService();
      const result = service.validateConfidence(1.5);
      expect(result.errors).toContain('CONFIDENCE_OUT_OF_RANGE');
    });

    it('accepts a valid in-range value', () => {
      const service = makeService();
      const result = service.validateConfidence(0.42);
      expect(result.valid).toBe(true);
      expect(result.confidence).toBe(0.42);
      expect(result.errors).toEqual([]);
    });
  });

  describe('validateKnowledgeResponse', () => {
    it('errors when the input is not an array', () => {
      const service = makeService();
      const result = service.validateKnowledgeResponse(null);
      expect(result.errors).toContain('KNOWLEDGE_RESPONSE_NOT_ARRAY');
    });

    it('accepts a well-formed search result', () => {
      const service = makeService();
      const result = service.validateKnowledgeResponse([
        { node: { id: 'skill-1', name: 'Python' }, nodeType: 'SKILL' },
      ]);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('errors on a node missing id/name', () => {
      const service = makeService();
      const result = service.validateKnowledgeResponse([{ node: {}, nodeType: 'SKILL' }]);
      expect(result.errors).toContain('KNOWLEDGE_RESPONSE_NODE_INCOMPLETE:0');
    });

    it('warns on an unrecognized nodeType', () => {
      const service = makeService();
      const result = service.validateKnowledgeResponse([
        { node: { id: 'x', name: 'X' }, nodeType: 'NOT_A_REAL_TYPE' },
      ]);
      expect(result.warnings).toContain('KNOWLEDGE_RESPONSE_UNKNOWN_NODE_TYPE:0:NOT_A_REAL_TYPE');
    });
  });

  describe('validateRecommendationCandidates', () => {
    it('errors when the input is missing', () => {
      const service = makeService();
      const result = service.validateRecommendationCandidates(null);
      expect(result.errors).toContain('RECOMMENDATION_RESPONSE_MISSING');
    });

    it('accepts a well-formed response', () => {
      const service = makeService();
      const result = service.validateRecommendationCandidates(makeCompleteCandidatesResponse());
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('errors when a documented group is missing entirely', () => {
      const service = makeService();
      const response = makeCompleteCandidatesResponse();
      delete response.careerRecommendations;
      const result = service.validateRecommendationCandidates(response);
      expect(result.errors).toContain('MISSING_GROUP:careerRecommendations');
    });

    it('warns when an unavailable group has no reason', () => {
      const service = makeService();
      const response = makeCompleteCandidatesResponse({
        careerRecommendations: { available: false, candidates: [] },
      });
      const result = service.validateRecommendationCandidates(response);
      expect(result.warnings).toContain('GROUP_UNAVAILABLE_MISSING_REASON:careerRecommendations');
    });

    it('errors when a skill candidate is missing required fields', () => {
      const service = makeService();
      const response = makeCompleteCandidatesResponse({
        skillRecommendations: { available: true, candidates: [{ name: 'Python' }] },
      });
      const result = service.validateRecommendationCandidates(response);
      expect(result.errors.some((e) => e.startsWith('SKILL_CANDIDATE_INCOMPLETE:0:'))).toBe(true);
    });

    // WP-XAI2-05 — Enterprise Decision Validation Runtime
    describe('decisionType: career', () => {
      it('does not deep-validate careerRecommendations when decisionType is skill (default)', () => {
        const service = makeService();
        const response = makeCompleteCandidatesResponse({
          careerRecommendations: { available: true, candidates: [{ name: 'Data Science' }] },
        });
        const result = service.validateRecommendationCandidates(response);
        expect(result.errors.some((e) => e.startsWith('CAREER_CANDIDATE_INCOMPLETE:'))).toBe(false);
      });

      it('deep-validates careerRecommendations when decisionType is career', () => {
        const service = makeService();
        const response = makeCareerCandidatesResponse({
          careerRecommendations: { available: true, candidates: [{ name: 'Data Science' }] },
        });
        const result = service.validateRecommendationCandidates(response, 'career');
        expect(result.errors.some((e) => e.startsWith('CAREER_CANDIDATE_INCOMPLETE:0:'))).toBe(true);
      });

      it('does not flag a null matchedFrom as incomplete for career (the documented listDomains() fallback shape)', () => {
        const service = makeService();
        const response = makeCareerCandidatesResponse({
          careerRecommendations: {
            available: true,
            candidates: [{ canonicalId: 'domain-1', name: 'Data Science', nodeType: 'DOMAIN', matchedFrom: null }],
          },
        });
        const result = service.validateRecommendationCandidates(response, 'career');
        expect(result.errors.some((e) => e.startsWith('CAREER_CANDIDATE_INCOMPLETE:'))).toBe(false);
      });

      it('still runs every generic per-group structural check regardless of decisionType', () => {
        const service = makeService();
        const response = makeCompleteCandidatesResponse();
        delete response.careerRecommendations;
        const result = service.validateRecommendationCandidates(response, 'career');
        expect(result.errors).toContain('MISSING_GROUP:careerRecommendations');
      });
    });
  });

  describe('validateFairness (WP-XAI2-01, Phase 1)', () => {
    it('returns evaluated:false, fired:false, and a note explaining why — never fabricates a demographic proxy', () => {
      const service = makeService();
      const result = service.validateFairness();

      expect(result.evaluated).toBe(false);
      expect(result.fired).toBe(false);
      expect(typeof result.note).toBe('string');
      expect(result.note.length).toBeGreaterThan(0);
    });

    it('takes no arguments in Phase 1 — there is no per-student data to evaluate against yet', () => {
      const service = makeService();
      expect(ValidationService.prototype.validateFairness.length).toBe(0);
      expect(service.validateFairness()).toEqual(service.validateFairness('anything', 'is-ignored'));
    });
  });

  describe('validateConsistency', () => {
    it('is valid (no crash) when either side is missing', () => {
      const service = makeService();
      expect(service.validateConsistency(null, null).valid).toBe(true);
    });

    it('errors when userIds mismatch between the two responses', () => {
      const service = makeService();
      const result = service.validateConsistency(
        makeCompleteCandidatesResponse({ userId: 'user-2' }),
        makeCompleteStudentContext({ userId: 'user-1' })
      );
      expect(result.errors).toContain('USER_ID_MISMATCH');
    });

    it('warns when a skill candidate\'s matchedFrom is not in the student\'s stated skills', () => {
      const service = makeService();
      const result = service.validateConsistency(
        makeCompleteCandidatesResponse({
          skillRecommendations: {
            available: true,
            candidates: [{ canonicalId: 'x', name: 'Rust', nodeType: 'SKILL', matchedFrom: 'Rust' }],
          },
        }),
        makeCompleteStudentContext({ skills: { legacy: ['Python'] } })
      );
      expect(result.warnings).toContain('SKILL_MATCH_SOURCE_MISMATCH:0');
    });

    // WP-XAI2-05 — Enterprise Decision Validation Runtime
    describe('decisionType: career', () => {
      it('does not cross-check careerRecommendations when decisionType is skill (default)', () => {
        const service = makeService();
        const result = service.validateConsistency(
          makeCareerCandidatesResponse({
            careerRecommendations: {
              available: true,
              candidates: [{ canonicalId: 'x', name: 'Nursing', nodeType: 'DOMAIN', matchedFrom: 'Nursing' }],
            },
          }),
          makeCompleteStudentContext({ career: { interests: { available: true, value: 'Engineering' }, goals: { available: false, value: null } } })
        );
        expect(result.warnings).toEqual([]);
      });

      it('warns when a career candidate\'s matchedFrom is not in the student\'s stated interests/goals', () => {
        const service = makeService();
        const result = service.validateConsistency(
          makeCareerCandidatesResponse({
            careerRecommendations: {
              available: true,
              candidates: [{ canonicalId: 'x', name: 'Nursing', nodeType: 'DOMAIN', matchedFrom: 'Nursing' }],
            },
          }),
          makeCompleteStudentContext({ career: { interests: { available: true, value: 'Engineering' }, goals: { available: false, value: null } } }),
          'career'
        );
        expect(result.warnings).toContain('CAREER_MATCH_SOURCE_MISMATCH:0');
      });

      it('does not warn for a null matchedFrom (the documented listDomains() fallback shape)', () => {
        const service = makeService();
        const result = service.validateConsistency(
          makeCareerCandidatesResponse({
            careerRecommendations: {
              available: true,
              candidates: [{ canonicalId: 'x', name: 'Nursing', nodeType: 'DOMAIN', matchedFrom: null }],
            },
          }),
          makeCompleteStudentContext({ career: { interests: { available: false, value: null }, goals: { available: false, value: null } } }),
          'career'
        );
        expect(result.warnings).toEqual([]);
      });
    });
  });

  describe('validateDecisionReadiness', () => {
    it('returns the standard ValidationResult shape', async () => {
      const service = makeService();
      const result = await service.validateDecisionReadiness('user-1');

      expect(result).toEqual(
        expect.objectContaining({
          userId: 'user-1',
          valid: expect.any(Boolean),
          score: expect.any(Number),
          warnings: expect.any(Array),
          errors: expect.any(Array),
          missingData: expect.any(Array),
          qualityFlags: expect.any(Array),
          fairness: expect.objectContaining({ evaluated: expect.any(Boolean), fired: expect.any(Boolean), note: expect.any(String) }),
          recommendations: expect.any(Array),
        })
      );
    });

    // WP-XAI2-01 (ADR-01/ADR-04/ADR-05) — Enterprise Fairness Gate, Phase 1.
    describe('fairness (WP-XAI2-01, Phase 1)', () => {
      it('is always evaluated:false and never fires, regardless of profile completeness or score', async () => {
        const service = makeService();
        const result = await service.validateDecisionReadiness('user-1');

        expect(result.fairness).toEqual({ evaluated: false, fired: false, note: expect.any(String) });
      });

      it('does not affect valid/score — fairness is reported, not gated on, in Phase 1', async () => {
        const service = makeService();
        const result = await service.validateDecisionReadiness('user-1');

        expect(result.valid).toBe(true);
        expect(result.score).toBeGreaterThanOrEqual(0.6);
      });
    });

    it('is valid and scores at/above the decision-ready threshold for a complete, consistent profile', async () => {
      const service = makeService();
      const result = await service.validateDecisionReadiness('user-1');
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(0.6);
      expect(result.confidence).toBe(0.75);
    });

    it('is not valid when RecommendationService returns a structurally broken response', async () => {
      const service = makeService({
        recommendationService: makeRecommendationService({
          generateRecommendationCandidates: jest.fn(async () => ({ userId: 'user-1' })),
        }),
      });
      const result = await service.validateDecisionReadiness('user-1');
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('flags IQF_QUALITY_REPORT_UNAVAILABLE when qualityService is not provided', async () => {
      const service = makeService({ qualityService: null });
      const result = await service.validateDecisionReadiness('user-1');
      expect(result.qualityFlags).toContain('IQF_QUALITY_REPORT_UNAVAILABLE');
    });

    it('flags IQF_QUALITY_REPORT_UNAVAILABLE and continues (does not throw) when IQF fails', async () => {
      const service = makeService({
        qualityService: makeQualityService({
          getQualityReport: jest.fn(async () => {
            throw new Error('boom');
          }),
        }),
      });
      const result = await service.validateDecisionReadiness('user-1');
      expect(result.qualityFlags).toContain('IQF_QUALITY_REPORT_UNAVAILABLE');
    });

    it('flags LOW_SIGNAL_COVERAGE from a real IQF coverage report', async () => {
      const service = makeService({
        qualityService: makeQualityService({
          getQualityReport: jest.fn(async () => ({
            coverage: { coverageLevel: 'low' },
            drift: null,
          })),
        }),
      });
      const result = await service.validateDecisionReadiness('user-1');
      expect(result.qualityFlags).toContain('LOW_SIGNAL_COVERAGE');
    });

    it('flags CLUSTER_DRIFT_PRIMARY_CLUSTER_SWAPPED from a real IQF drift report', async () => {
      const service = makeService({
        qualityService: makeQualityService({
          getQualityReport: jest.fn(async () => ({
            coverage: null,
            drift: { clusterSwapped: true, driftLevel: 'moderate' },
          })),
        }),
      });
      const result = await service.validateDecisionReadiness('user-1');
      expect(result.qualityFlags).toContain('CLUSTER_DRIFT_PRIMARY_CLUSTER_SWAPPED');
    });

    it('is cache-first: a cache hit short-circuits calls to the collaborator services', async () => {
      const store = new Map();
      store.set('validation-runtime:decision-readiness:user-1', JSON.stringify({ userId: 'user-1', cached: true }));
      const cacheClient = makeCacheClient({ store });
      const studentService = makeStudentService();
      const recommendationService = makeRecommendationService();

      const service = makeService({ cacheClient, studentService, recommendationService });
      const result = await service.validateDecisionReadiness('user-1');

      expect(result).toEqual({ userId: 'user-1', cached: true });
      expect(studentService.getStudentIntelligenceProfile).not.toHaveBeenCalled();
      expect(recommendationService.generateRecommendationCandidates).not.toHaveBeenCalled();
    });

    it('writes through to the cache on a miss', async () => {
      const cacheClient = makeCacheClient();
      const service = makeService({ cacheClient });

      await service.validateDecisionReadiness('user-1');

      expect(cacheClient.set).toHaveBeenCalledTimes(1);
      const [key] = cacheClient.set.mock.calls[0];
      expect(key).toBe('validation-runtime:decision-readiness:user-1');
    });

    // WP-XAI2-05 — Enterprise Decision Validation Runtime
    it('namespaces the cache key by decisionType for a non-default decisionType, so career and skill never collide', async () => {
      const cacheClient = makeCacheClient();
      const service = makeService({ cacheClient });

      await service.validateDecisionReadiness('user-1', 'career');

      expect(cacheClient.set).toHaveBeenCalledTimes(1);
      const [key] = cacheClient.set.mock.calls[0];
      expect(key).toBe('validation-runtime:decision-readiness:career:user-1');
    });

    it('runs career-specific deep validation end-to-end when decisionType is career', async () => {
      const service = makeService({
        recommendationService: makeRecommendationService({
          generateRecommendationCandidates: jest.fn(async () => makeCareerCandidatesResponse()),
        }),
        studentService: makeStudentService({
          getStudentIntelligenceProfile: jest.fn(async () =>
            makeCompleteStudentContext({ career: { interests: { available: true, value: 'Data Science' }, goals: { available: false, value: null } } })
          ),
        }),
      });

      const result = await service.validateDecisionReadiness('user-1', 'career');
      expect(result.errors).toEqual([]);
      expect(result.meta.decisionType).toBe('career');
    });

    it('continues (best-effort) when the cache client throws', async () => {
      const cacheClient = {
        get: jest.fn(async () => {
          throw new Error('cache down');
        }),
        set: jest.fn(async () => {
          throw new Error('cache down');
        }),
      };
      const service = makeService({ cacheClient });

      await expect(service.validateDecisionReadiness('user-1')).resolves.toBeDefined();
    });
  });
});