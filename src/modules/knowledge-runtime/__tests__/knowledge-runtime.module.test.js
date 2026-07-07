'use strict';

/**
 * modules/knowledge-runtime/__tests__/knowledge-runtime.module.test.js
 *
 * Covers the composition root itself: singleton caching for every getter
 * (Objective 9 "Singleton initialization"), the frozen build order
 * (Objective 5 — ValidationService is registered/constructed after
 * RecommendationService), and the resolver-based wiring that lets
 * RecommendationService reach ValidationService without a require-cycle
 * (Objective 6 — see knowledge-runtime.module.js's header for the full
 * reasoning).
 *
 * Every collaborator class and the IQF module are mocked here — this file
 * tests wiring, not KnowledgeService/StudentService/RecommendationService/
 * ValidationService's own logic (each has its own dedicated test suite).
 */

jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../../../core/cache/cache.manager', () => ({
  getClient: jest.fn(() => null),
}));

jest.mock('../knowledge/knowledge.service');
jest.mock('../knowledge/knowledge.repository', () => ({
  KnowledgeRepository: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../student/studentIntelligence.service');
jest.mock('../student/studentIntelligence.repository', () => ({
  StudentIntelligenceRepository: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../recommendation/recommendation.service');
jest.mock('../validation/validation.service');
jest.mock('../decision/decision.service');
jest.mock('../explainability/explainability.service');

jest.mock('../../intelligence-quality/intelligence-quality.module', () => ({
  getQualityService: jest.fn(() => ({ mockQualityService: true })),
}));

// Reused verbatim, not wrapped — mocked out so requiring this module never
// touches real repositories/Supabase.
jest.mock('../../../repositories/career.repository', () => ({}));
jest.mock('../../../repositories/skillRepository', () => jest.fn().mockImplementation(() => ({})));
jest.mock('../../education-intelligence/repositories/student.repository', () => ({}));
jest.mock('../../student-onboarding/services/education.service', () => ({}));

describe('knowledge-runtime.module', () => {
  let mod;
  let KnowledgeService;
  let StudentService;
  let RecommendationService;
  let ValidationService;
  let DecisionEngine;
  let ExplainabilityRuntime;
  let getQualityService;

  beforeEach(() => {
    jest.resetModules();

    KnowledgeService = require('../knowledge/knowledge.service');
    StudentService = require('../student/studentIntelligence.service');
    RecommendationService = require('../recommendation/recommendation.service');
    ValidationService = require('../validation/validation.service');
    DecisionEngine = require('../decision/decision.service');
    ExplainabilityRuntime = require('../explainability/explainability.service');
    ({ getQualityService } = require('../../intelligence-quality/intelligence-quality.module'));

    // Re-require after resetModules so each test gets fresh singletons AND
    // the mock constructor references above match the ones the module
    // under test actually calls (resetModules gives every `require()` a
    // fresh module registry entry).
    mod = require('../knowledge-runtime.module');
  });

  describe('singleton initialization (Objective 9)', () => {
    it('getKnowledgeService returns the same instance on every call', () => {
      const a = mod.getKnowledgeService();
      const b = mod.getKnowledgeService();
      expect(a).toBe(b);
      expect(KnowledgeService).toHaveBeenCalledTimes(1);
    });

    it('getStudentService returns the same instance on every call', () => {
      const a = mod.getStudentService();
      const b = mod.getStudentService();
      expect(a).toBe(b);
      expect(StudentService).toHaveBeenCalledTimes(1);
    });

    it('getRecommendationService returns the same instance on every call', () => {
      const a = mod.getRecommendationService();
      const b = mod.getRecommendationService();
      expect(a).toBe(b);
      expect(RecommendationService).toHaveBeenCalledTimes(1);
    });

    it('getValidationService returns the same instance on every call', () => {
      const a = mod.getValidationService();
      const b = mod.getValidationService();
      expect(a).toBe(b);
      expect(ValidationService).toHaveBeenCalledTimes(1);
    });

    it('getDecisionService returns the same instance on every call', () => {
      const a = mod.getDecisionService();
      const b = mod.getDecisionService();
      expect(a).toBe(b);
      expect(DecisionEngine).toHaveBeenCalledTimes(1);
    });

    it('getExplainabilityService returns the same instance on every call', () => {
      const a = mod.getExplainabilityService();
      const b = mod.getExplainabilityService();
      expect(a).toBe(b);
      expect(ExplainabilityRuntime).toHaveBeenCalledTimes(1);
    });
  });

  describe('WP-IMP-06 — ExplainabilityRuntime construction', () => {
    it('constructs ExplainabilityRuntime with only logger/config, no runtime-service dependency', () => {
      mod.getExplainabilityService();

      expect(ExplainabilityRuntime).toHaveBeenCalledWith(
        expect.objectContaining({ logger: expect.anything(), config: expect.anything() })
      );
      const [[constructedWith]] = ExplainabilityRuntime.mock.calls;
      expect(constructedWith).not.toHaveProperty('knowledgeService');
      expect(constructedWith).not.toHaveProperty('studentService');
      expect(constructedWith).not.toHaveProperty('recommendationService');
      expect(constructedWith).not.toHaveProperty('validationService');
      expect(constructedWith).not.toHaveProperty('decisionService');
    });

    it('does not require any other service to already be built', () => {
      mod.getExplainabilityService();

      expect(KnowledgeService).not.toHaveBeenCalled();
      expect(StudentService).not.toHaveBeenCalled();
      expect(RecommendationService).not.toHaveBeenCalled();
      expect(ValidationService).not.toHaveBeenCalled();
      expect(DecisionEngine).not.toHaveBeenCalled();
    });
  });

  describe('WP-IMP-05 — DecisionEngine build order and DI', () => {
    it('getDecisionService builds Knowledge, Student, Recommendation, and Validation first', () => {
      mod.getDecisionService();

      expect(KnowledgeService).toHaveBeenCalledTimes(1);
      expect(StudentService).toHaveBeenCalledTimes(1);
      expect(RecommendationService).toHaveBeenCalledTimes(1);
      expect(ValidationService).toHaveBeenCalledTimes(1);
      expect(DecisionEngine).toHaveBeenCalledTimes(1);
    });

    it('getDecisionService injects knowledgeService, studentService, recommendationService, and validationService', () => {
      const knowledgeService = mod.getKnowledgeService();
      const studentService = mod.getStudentService();
      const recommendationService = mod.getRecommendationService();
      const validationService = mod.getValidationService();

      mod.getDecisionService();

      expect(DecisionEngine).toHaveBeenCalledWith(
        expect.objectContaining({
          knowledgeService,
          studentService,
          recommendationService,
          validationService,
        })
      );
    });

    it('does not construct DecisionEngine merely by constructing ValidationService (lazy, on-demand build)', () => {
      mod.getValidationService();

      expect(DecisionEngine).not.toHaveBeenCalled();
    });
  });

  describe('build order (Objective 5 — Validation registered after Recommendation)', () => {
    it('getValidationService builds Knowledge, Student, and Recommendation first', () => {
      mod.getValidationService();

      expect(KnowledgeService).toHaveBeenCalledTimes(1);
      expect(StudentService).toHaveBeenCalledTimes(1);
      expect(RecommendationService).toHaveBeenCalledTimes(1);
      expect(ValidationService).toHaveBeenCalledTimes(1);
    });

    it('getValidationService injects knowledgeService, studentService, recommendationService, and qualityService', () => {
      const knowledgeService = mod.getKnowledgeService();
      const studentService = mod.getStudentService();
      const recommendationService = mod.getRecommendationService();

      mod.getValidationService();

      expect(ValidationService).toHaveBeenCalledWith(
        expect.objectContaining({
          knowledgeService,
          studentService,
          recommendationService,
          qualityService: { mockQualityService: true },
        })
      );
    });

    it('does not fail ValidationService construction when IQF getQualityService throws (best-effort)', () => {
      getQualityService.mockImplementationOnce(() => {
        throw new Error('IQF unavailable');
      });

      expect(() => mod.getValidationService()).not.toThrow();
      expect(ValidationService).toHaveBeenCalledWith(expect.objectContaining({ qualityService: null }));
    });
  });

  describe('validation-gate resolver wiring (Objective 6)', () => {
    it('constructs RecommendationService with a validationServiceResolver function', () => {
      mod.getRecommendationService();

      expect(RecommendationService).toHaveBeenCalledWith(
        expect.objectContaining({ validationServiceResolver: expect.any(Function) })
      );
    });

    it('the resolver does not build ValidationService at RecommendationService construction time', () => {
      mod.getRecommendationService();

      expect(ValidationService).not.toHaveBeenCalled();
    });

    it('invoking the resolver later returns the (now-built) ValidationService singleton', () => {
      mod.getRecommendationService();
      const [[constructedWith]] = RecommendationService.mock.calls;

      const resolved = constructedWith.validationServiceResolver();

      expect(ValidationService).toHaveBeenCalledTimes(1);
      expect(resolved).toBe(mod.getValidationService());
    });
  });

  describe('_setServiceForTesting', () => {
    it('overrides the validation singleton', () => {
      const mockInstance = { mocked: true };
      mod._setServiceForTesting('validation', mockInstance);
      expect(mod.getValidationService()).toBe(mockInstance);
      expect(ValidationService).not.toHaveBeenCalled();
    });

    it('overrides the decision singleton', () => {
      const mockInstance = { mocked: true };
      mod._setServiceForTesting('decision', mockInstance);
      expect(mod.getDecisionService()).toBe(mockInstance);
      expect(DecisionEngine).not.toHaveBeenCalled();
    });

    it('overrides the explainability singleton', () => {
      const mockInstance = { mocked: true };
      mod._setServiceForTesting('explainability', mockInstance);
      expect(mod.getExplainabilityService()).toBe(mockInstance);
      expect(ExplainabilityRuntime).not.toHaveBeenCalled();
    });

    it('throws for an unknown service name', () => {
      expect(() => mod._setServiceForTesting('not-a-real-service', {})).toThrow(/unknown or not-yet-implemented/);
    });
  });
});
