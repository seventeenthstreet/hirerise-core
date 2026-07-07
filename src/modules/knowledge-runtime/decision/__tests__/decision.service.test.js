'use strict';

/**
 * modules/knowledge-runtime/decision/__tests__/decision.service.test.js
 *
 * Mocks KnowledgeService, StudentService, RecommendationService, and
 * ValidationService — DecisionEngine's own rule-evaluation logic is real,
 * unmocked, matching validation.service.test.js's precedent (Objective 9
 * of the sibling WPs: each service's own logic is tested against real
 * code, not against mocks of itself).
 */

const fs = require('fs');
const path = require('path');

const DecisionEngine = require('../decision.service');
const { DECISION_STATUS, PRIORITY, KNOWN_DECISION_TYPES, IMPLEMENTED_DECISION_TYPES } = DecisionEngine;

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeKnowledgeService(overrides = {}) {
  return { searchKnowledge: jest.fn(async () => []), ...overrides };
}

function makeStudentService(overrides = {}) {
  return { getStudentIntelligenceProfile: jest.fn(async () => ({ userId: 'user-1' })), ...overrides };
}

function makeValidationResult(overrides = {}) {
  return {
    userId: 'user-1',
    valid: true,
    score: 0.9,
    confidence: 0.9,
    warnings: [],
    errors: [],
    missingData: [],
    qualityFlags: [],
    // WP-XAI2-01: Phase 1 default — matches ValidationService.validateFairness()'s
    // real, honest never-fires-yet shape (ADR-01/ADR-04).
    fairness: { evaluated: false, fired: false, note: 'No demographic attribute data exists.' },
    recommendations: [],
    meta: { generatedAt: '2026-01-01T00:00:00.000Z', scoreWeights: {}, decisionReadyThreshold: 0.6 },
    ...overrides,
  };
}

function makeValidationService(overrides = {}) {
  return {
    validateDecisionReadiness: jest.fn(async () => makeValidationResult()),
    ...overrides,
  };
}

function makeSkillCandidatesResponse(overrides = {}) {
  return {
    userId: 'user-1',
    skillRecommendations: {
      available: true,
      candidates: [{ canonicalId: 'skill-1', name: 'Python', nodeType: 'SKILL', matchedFrom: 'Python' }],
    },
    meta: { generatedAt: '2026-01-01T00:00:00.000Z', pipeline: 'deterministic-rule-matching-v1' },
    ...overrides,
  };
}

function makeRecommendationService(overrides = {}) {
  return {
    generateRecommendationCandidates: jest.fn(async () => makeSkillCandidatesResponse()),
    ...overrides,
  };
}

function makeCareerCandidatesResponse(overrides = {}) {
  return {
    userId: 'user-1',
    careerRecommendations: {
      available: true,
      candidates: [{ canonicalId: 'domain-1', name: 'Engineering', nodeType: 'DOMAIN', matchedFrom: 'technology', matchStrategy: 'stated-career-interest-or-goal-name-match' }],
    },
    meta: { generatedAt: '2026-01-01T00:00:00.000Z', pipeline: 'deterministic-rule-matching-v1' },
    ...overrides,
  };
}

function makeEngine(overrides = {}) {
  return new DecisionEngine({
    knowledgeService: makeKnowledgeService(),
    studentService: makeStudentService(),
    recommendationService: makeRecommendationService(),
    validationService: makeValidationService(),
    logger: makeLogger(),
    ...overrides,
  });
}

describe('DecisionEngine', () => {
  // ─────────────────────────────────────────────────────────
  // CONSTRUCTOR / DEPENDENCY INJECTION
  // ─────────────────────────────────────────────────────────
  describe('constructor dependency injection', () => {
    const validDeps = () => ({
      knowledgeService: makeKnowledgeService(),
      studentService: makeStudentService(),
      recommendationService: makeRecommendationService(),
      validationService: makeValidationService(),
      logger: makeLogger(),
    });

    it('constructs successfully with all required dependencies', () => {
      expect(() => new DecisionEngine(validDeps())).not.toThrow();
    });

    it('throws without knowledgeService', () => {
      const deps = validDeps();
      delete deps.knowledgeService;
      expect(() => new DecisionEngine(deps)).toThrow(/knowledgeService is required/);
    });

    it('throws without studentService', () => {
      const deps = validDeps();
      delete deps.studentService;
      expect(() => new DecisionEngine(deps)).toThrow(/studentService is required/);
    });

    it('throws without recommendationService', () => {
      const deps = validDeps();
      delete deps.recommendationService;
      expect(() => new DecisionEngine(deps)).toThrow(/recommendationService is required/);
    });

    it('throws without validationService', () => {
      const deps = validDeps();
      delete deps.validationService;
      expect(() => new DecisionEngine(deps)).toThrow(/validationService is required/);
    });

    it('throws without logger', () => {
      const deps = validDeps();
      delete deps.logger;
      expect(() => new DecisionEngine(deps)).toThrow(/logger is required/);
    });
  });

  // ─────────────────────────────────────────────────────────
  // DR-TYP-01 — NON-SKILL DECISION TYPES
  // ─────────────────────────────────────────────────────────
  describe('DR-TYP-01 — non-implemented decisionType', () => {
    it('returns WITHHELD for every known non-implemented decisionType without ever calling ValidationService', async () => {
      const nonImplementedTypes = KNOWN_DECISION_TYPES.filter((t) => !IMPLEMENTED_DECISION_TYPES.includes(t));
      expect(nonImplementedTypes.length).toBeGreaterThan(0);

      for (const decisionType of nonImplementedTypes) {
        const validationService = makeValidationService();
        const recommendationService = makeRecommendationService({
          generateRecommendationCandidates: jest.fn(async () => ({
            userId: 'user-1',
            [`${decisionType}Recommendations`]: {
              available: false,
              candidates: [],
              reason: `No implementation exists for ${decisionType}.`,
            },
            meta: { generatedAt: '2026-01-01T00:00:00.000Z' },
          })),
        });
        const engine = makeEngine({ validationService, recommendationService });

        const decision = await engine.decide('user-1', decisionType);

        expect(decision.status).toBe(DECISION_STATUS.WITHHELD);
        expect(decision.decisionType).toBe(decisionType);
        expect(decision.priority).toBeNull();
        expect(decision.confidence).toBeNull();
        expect(decision.qualityScore).toBeNull();
        expect(decision.metadata.reason).toBe(`No implementation exists for ${decisionType}.`);
        expect(validationService.validateDecisionReadiness).not.toHaveBeenCalled();
        expect(decision.decisionFactors[0]).toMatchObject({ ruleId: 'DR-TYP-01', fired: true });
      }
    });

    it('falls back to a generic reason if RecommendationService throws while resolving the reason', async () => {
      const recommendationService = makeRecommendationService({
        generateRecommendationCandidates: jest.fn(async () => {
          throw new Error('boom');
        }),
      });
      const engine = makeEngine({ recommendationService });

      const decision = await engine.decide('user-1', 'occupation');

      expect(decision.status).toBe(DECISION_STATUS.WITHHELD);
      expect(decision.metadata.reason).toMatch(/does not implement/);
    });

    it('produces a well-formed Decision (all contract fields present) for a WITHHELD DR-TYP-01 result', async () => {
      const engine = makeEngine();
      const decision = await engine.decide('user-1', 'occupation');

      for (const field of [
        'decisionId',
        'timestamp',
        'userId',
        'decisionType',
        'status',
        'confidence',
        'qualityScore',
        'priority',
        'recommendedActions',
        'evidence',
        'reasoningTrace',
        'confidenceBreakdown',
        'decisionFactors',
        'metadata',
      ]) {
        expect(decision).toHaveProperty(field);
      }
      expect(decision.confidenceBreakdown.bandLabel).toBeNull();
      expect(Object.keys(decision.confidenceBreakdown.inputs)).toEqual(
        expect.arrayContaining(['evidenceCoverage', 'signalCompleteness', 'signalConsistency', 'dataQuality', 'recommendationStability', 'profileCompleteness'])
      );
    });
  });

  // ─────────────────────────────────────────────────────────
  // SKILL PATH — DR-INT-01
  // ─────────────────────────────────────────────────────────
  describe('DR-INT-01 — structural contract gate (skill)', () => {
    it('returns WITHHELD when ValidationService reports structural errors, and does not call RecommendationService for candidates', async () => {
      const validationService = makeValidationService({
        validateDecisionReadiness: jest.fn(async () => makeValidationResult({ errors: ['USER_ID_MISMATCH'], valid: false })),
      });
      const recommendationService = makeRecommendationService();
      const engine = makeEngine({ validationService, recommendationService });

      const decision = await engine.decide('user-1', 'skill');

      expect(decision.status).toBe(DECISION_STATUS.WITHHELD);
      // WP-XAI2-05: decisionType is now threaded through to ValidationService.
      expect(validationService.validateDecisionReadiness).toHaveBeenCalledWith('user-1', 'skill');
      expect(recommendationService.generateRecommendationCandidates).not.toHaveBeenCalled();
      expect(decision.decisionFactors.find((f) => f.ruleId === 'DR-INT-01')).toMatchObject({ fired: true });
    });

    it('always calls ValidationService.validateDecisionReadiness exactly once for a skill decision', async () => {
      const validationService = makeValidationService();
      const engine = makeEngine({ validationService });

      await engine.decide('user-1', 'skill');

      expect(validationService.validateDecisionReadiness).toHaveBeenCalledTimes(1);
      // WP-XAI2-05: decisionType is now threaded through to ValidationService.
      expect(validationService.validateDecisionReadiness).toHaveBeenCalledWith('user-1', 'skill');
    });
  });

  // ─────────────────────────────────────────────────────────
  // DR-ESC-01
  // ─────────────────────────────────────────────────────────
  describe('DR-ESC-01 — critical contradiction escalation', () => {
    it.each(['CLUSTER_DRIFT_PRIMARY_CLUSTER_SWAPPED', 'CLUSTER_DRIFT_HIGH'])(
      'returns ESCALATION_REQUIRED with priority P0 when %s is present',
      async (flag) => {
        const validationService = makeValidationService({
          validateDecisionReadiness: jest.fn(async () => makeValidationResult({ qualityFlags: [flag] })),
        });
        const engine = makeEngine({ validationService });

        const decision = await engine.decide('user-1', 'skill');

        expect(decision.status).toBe(DECISION_STATUS.ESCALATION_REQUIRED);
        expect(decision.priority).toBe(PRIORITY.P0);
        expect(decision.metadata.counsellorActionRequired).toBe(true);
        expect(decision.recommendedActions).toEqual(expect.arrayContaining([expect.stringMatching(/counsellor review/i)]));
      }
    );

    it('does not escalate when qualityFlags contains no CLUSTER_DRIFT flag', async () => {
      const validationService = makeValidationService({
        validateDecisionReadiness: jest.fn(async () => makeValidationResult({ qualityFlags: ['LOW_SIGNAL_COVERAGE'] })),
      });
      const engine = makeEngine({ validationService });

      const decision = await engine.decide('user-1', 'skill');

      expect(decision.status).not.toBe(DECISION_STATUS.ESCALATION_REQUIRED);
    });
  });

  // ─────────────────────────────────────────────────────────
  // DR-SUF-01
  // ─────────────────────────────────────────────────────────
  describe('DR-SUF-01 — evidence floor gate', () => {
    it('returns INSUFFICIENT_EVIDENCE with priority P4 when no skill candidates are available', async () => {
      const recommendationService = makeRecommendationService({
        generateRecommendationCandidates: jest.fn(async () => makeSkillCandidatesResponse({
          skillRecommendations: { available: true, candidates: [] },
        })),
      });
      const engine = makeEngine({ recommendationService });

      const decision = await engine.decide('user-1', 'skill');

      expect(decision.status).toBe(DECISION_STATUS.INSUFFICIENT_EVIDENCE);
      expect(decision.priority).toBe(PRIORITY.P4);
    });

    it('returns INSUFFICIENT_EVIDENCE when the skill group itself is unavailable', async () => {
      const recommendationService = makeRecommendationService({
        generateRecommendationCandidates: jest.fn(async () => makeSkillCandidatesResponse({
          skillRecommendations: { available: false, candidates: [], reason: 'no skills on profile' },
        })),
      });
      const engine = makeEngine({ recommendationService });

      const decision = await engine.decide('user-1', 'skill');

      expect(decision.status).toBe(DECISION_STATUS.INSUFFICIENT_EVIDENCE);
    });

    it('passes DR-SUF-01 and proceeds when at least one skill candidate is present', async () => {
      const engine = makeEngine();
      const decision = await engine.decide('user-1', 'skill');

      expect(decision.decisionFactors.find((f) => f.ruleId === 'DR-SUF-01')).toMatchObject({ fired: false });
    });
  });

  // ─────────────────────────────────────────────────────────
  // DR-SUF-02
  // ─────────────────────────────────────────────────────────
  describe('DR-SUF-02 — profile completeness threshold (informational only)', () => {
    it('does not change status when LOW_STUDENT_PROFILE_COMPLETENESS is present, but records the factor', async () => {
      const validationService = makeValidationService({
        validateDecisionReadiness: jest.fn(async () => makeValidationResult({ qualityFlags: ['LOW_STUDENT_PROFILE_COMPLETENESS'] })),
      });
      const engine = makeEngine({ validationService });

      const decision = await engine.decide('user-1', 'skill');

      expect(decision.status).toBe(DECISION_STATUS.DECISION_READY);
      expect(decision.decisionFactors.find((f) => f.ruleId === 'DR-SUF-02')).toMatchObject({ fired: true });
    });
  });

  // ─────────────────────────────────────────────────────────
  // DR-CNF-01 — confidence band mapping / status
  // ─────────────────────────────────────────────────────────
  describe('DR-CNF-01 — confidence band mapping', () => {
    it('maps High/Very High band + valid:true to DECISION_READY with priority P2 and no fabricated fairness metadata', async () => {
      const validationService = makeValidationService({
        validateDecisionReadiness: jest.fn(async () => makeValidationResult({ score: 0.9, valid: true, confidence: 0.9 })),
      });
      const engine = makeEngine({ validationService });

      const decision = await engine.decide('user-1', 'skill');

      expect(decision.status).toBe(DECISION_STATUS.DECISION_READY);
      expect(decision.priority).toBe(PRIORITY.P2);
      expect(decision.confidenceBreakdown.bandLabel).toBe('Very High');
      // WP-XAI2-01 / ADR-01: the old bare `fairnessGatePending: true` literal
      // is gone from metadata — the honest disclosure now lives structurally
      // in decisionFactors as DR-FAIR-01 (see the dedicated describe block).
      expect(decision.metadata.fairnessGatePending).toBeUndefined();
      expect(decision.confidence).toBe(0.9);
      expect(decision.qualityScore).toBe(0.9);
    });

    it('maps Low band to PROVISIONAL with priority P3', async () => {
      const validationService = makeValidationService({
        validateDecisionReadiness: jest.fn(async () => makeValidationResult({ score: 0.35, valid: false, confidence: 0.35 })),
      });
      const engine = makeEngine({ validationService });

      const decision = await engine.decide('user-1', 'skill');

      expect(decision.status).toBe(DECISION_STATUS.PROVISIONAL);
      expect(decision.priority).toBe(PRIORITY.P3);
      expect(decision.confidenceBreakdown.bandLabel).toBe('Low');
      expect(decision.metadata.fairnessGatePending).toBeUndefined();
    });

    it('maps Very Low band to INSUFFICIENT_EVIDENCE with priority P4, even when candidates exist', async () => {
      const validationService = makeValidationService({
        validateDecisionReadiness: jest.fn(async () => makeValidationResult({ score: 0.1, valid: false, confidence: 0.1 })),
      });
      const engine = makeEngine({ validationService });

      const decision = await engine.decide('user-1', 'skill');

      expect(decision.status).toBe(DECISION_STATUS.INSUFFICIENT_EVIDENCE);
      expect(decision.priority).toBe(PRIORITY.P4);
    });

    it('resolves the Medium-band-but-invalid edge case (score in [0.50, 0.60)) to PROVISIONAL rather than DECISION_READY', async () => {
      const validationService = makeValidationService({
        validateDecisionReadiness: jest.fn(async () => makeValidationResult({ score: 0.55, valid: false, confidence: 0.55 })),
      });
      const engine = makeEngine({ validationService });

      const decision = await engine.decide('user-1', 'skill');

      expect(decision.confidenceBreakdown.bandLabel).toBe('Medium');
      expect(decision.status).toBe(DECISION_STATUS.PROVISIONAL);
    });

    it('never fabricates the six confidenceBreakdown sub-inputs — all remain null', async () => {
      const engine = makeEngine();
      const decision = await engine.decide('user-1', 'skill');

      for (const value of Object.values(decision.confidenceBreakdown.inputs)) {
        expect(value).toBeNull();
      }
    });
  });

  // ─────────────────────────────────────────────────────────
  // CAREER DECISION PATH (WP-XAI2-04) — the generalized
  // _decideImplementedType, exercised via 'career' instead of 'skill'.
  // Not a re-test of every rule (that's already covered above against
  // 'skill', and the rule chain is identical) — this targets the two
  // things that actually changed: the recommendation-group key derivation
  // and the DR-TYP-01 gate now admitting 'career'.
  // ─────────────────────────────────────────────────────────
  describe('career decision path (WP-XAI2-04)', () => {
    it('treats career as an implemented type: calls ValidationService and does not go through DR-TYP-01 WITHHELD', async () => {
      const validationService = makeValidationService();
      const recommendationService = makeRecommendationService({
        generateRecommendationCandidates: jest.fn(async () => makeCareerCandidatesResponse()),
      });
      const engine = makeEngine({ validationService, recommendationService });

      const decision = await engine.decide('user-1', 'career');

      // WP-XAI2-05: career decisions now request career-specific validation
      // from ValidationService instead of the skill-shaped default.
      expect(validationService.validateDecisionReadiness).toHaveBeenCalledWith('user-1', 'career');
      expect(decision.decisionFactors[0]).toMatchObject({ ruleId: 'DR-TYP-01', fired: false });
    });

    it('requests the careerRecommendations group, not skillRecommendations', async () => {
      const recommendationService = makeRecommendationService({
        generateRecommendationCandidates: jest.fn(async () => makeCareerCandidatesResponse()),
      });
      const engine = makeEngine({ recommendationService });

      await engine.decide('user-1', 'career');

      expect(recommendationService.generateRecommendationCandidates).toHaveBeenCalledWith('user-1', { groups: ['career'] });
    });

    it('reaches DECISION_READY for a high-confidence career decision with candidates present', async () => {
      const validationService = makeValidationService({
        validateDecisionReadiness: jest.fn(async () => makeValidationResult({ score: 0.9, valid: true, confidence: 0.9 })),
      });
      const recommendationService = makeRecommendationService({
        generateRecommendationCandidates: jest.fn(async () => makeCareerCandidatesResponse()),
      });
      const engine = makeEngine({ validationService, recommendationService });

      const decision = await engine.decide('user-1', 'career');

      expect(decision.status).toBe(DECISION_STATUS.DECISION_READY);
      expect(decision.priority).toBe(PRIORITY.P2);
      expect(decision.evidence).toEqual(makeCareerCandidatesResponse().careerRecommendations.candidates);
    });

    it('returns INSUFFICIENT_EVIDENCE when no career candidates are available', async () => {
      const recommendationService = makeRecommendationService({
        generateRecommendationCandidates: jest.fn(async () => makeCareerCandidatesResponse({
          careerRecommendations: { available: true, candidates: [] },
        })),
      });
      const engine = makeEngine({ recommendationService });

      const decision = await engine.decide('user-1', 'career');

      expect(decision.status).toBe(DECISION_STATUS.INSUFFICIENT_EVIDENCE);
      expect(decision.priority).toBe(PRIORITY.P4);
      expect(decision.decisionFactors.find((f) => f.ruleId === 'DR-SUF-01')).toMatchObject({
        fired: true,
        detail: expect.stringContaining('No career candidates were returned'),
      });
    });

    it('decisionFactors lists every rule actually evaluated, in the same order as the skill path', async () => {
      const recommendationService = makeRecommendationService({
        generateRecommendationCandidates: jest.fn(async () => makeCareerCandidatesResponse()),
      });
      const engine = makeEngine({ recommendationService });

      const decision = await engine.decide('user-1', 'career');

      const ruleIds = decision.decisionFactors.map((f) => f.ruleId);
      expect(ruleIds).toEqual(['DR-TYP-01', 'DR-FAIR-01', 'DR-INT-01', 'DR-ESC-02', 'DR-ESC-01', 'DR-SUF-01', 'DR-SUF-02', 'DR-CNF-01', 'DR-PRI-01', 'DR-PRI-02']);
    });
  });

  // ─────────────────────────────────────────────────────────
  // DR-PRI-01 / DR-PRI-02 — documented as not evaluated (data gap)
  // ─────────────────────────────────────────────────────────
  describe('DR-PRI-01 / DR-PRI-02 — documented data gaps', () => {
    it('records DR-PRI-01 and DR-PRI-02 as evaluated:false with an explanatory note', async () => {
      const engine = makeEngine();
      const decision = await engine.decide('user-1', 'skill');

      const pri01 = decision.decisionFactors.find((f) => f.ruleId === 'DR-PRI-01');
      const pri02 = decision.decisionFactors.find((f) => f.ruleId === 'DR-PRI-02');

      expect(pri01).toMatchObject({ evaluated: false });
      expect(pri02).toMatchObject({ evaluated: false });
      expect(pri01.note).toEqual(expect.any(String));
      expect(pri02.note).toEqual(expect.any(String));
    });
  });

  // ─────────────────────────────────────────────────────────
  // DR-FAIR-01 — WP-XAI2-01 Enterprise Fairness Gate, Phase 1
  // ─────────────────────────────────────────────────────────
  describe('DR-FAIR-01 — Enterprise Fairness Gate (Phase 1, ADR-01/ADR-04/ADR-05)', () => {
    it('records DR-FAIR-01 as evaluated:false with an explanatory note, quoting ValidationService.fairness verbatim', async () => {
      const validationService = makeValidationService({
        validateDecisionReadiness: jest.fn(async () =>
          makeValidationResult({ fairness: { evaluated: false, fired: false, note: 'No demographic data exists yet.' } })
        ),
      });
      const engine = makeEngine({ validationService });

      const decision = await engine.decide('user-1', 'skill');

      const fair01 = decision.decisionFactors.find((f) => f.ruleId === 'DR-FAIR-01');
      expect(fair01).toMatchObject({ evaluated: false, fired: false, note: 'No demographic data exists yet.' });
    });

    it('never fires, never withholds, and never changes status in Phase 1', async () => {
      const engine = makeEngine();
      const decision = await engine.decide('user-1', 'skill');

      const fair01 = decision.decisionFactors.find((f) => f.ruleId === 'DR-FAIR-01');
      expect(fair01.fired).toBe(false);
      expect(decision.status).not.toBe(DECISION_STATUS.WITHHELD);
    });

    it('does not appear at all for an unimplemented decisionType (DR-TYP-01 blocks before ValidationService runs)', async () => {
      const engine = makeEngine();
      const decision = await engine.decide('user-1', 'occupation');

      expect(decision.decisionFactors.find((f) => f.ruleId === 'DR-FAIR-01')).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────
  // OUTPUT CONTRACT / EXPLAINABILITY COMPATIBILITY
  // ─────────────────────────────────────────────────────────
  describe('Decision Output Contract (DECISION_OUTPUT_CONTRACT.md §Objective 8)', () => {
    it('produces every contract field for a DECISION_READY skill decision', async () => {
      const engine = makeEngine();
      const decision = await engine.decide('user-1', 'skill');

      for (const field of [
        'decisionId',
        'timestamp',
        'userId',
        'decisionType',
        'status',
        'confidence',
        'qualityScore',
        'priority',
        'recommendedActions',
        'evidence',
        'reasoningTrace',
        'confidenceBreakdown',
        'decisionFactors',
        'metadata',
      ]) {
        expect(decision).toHaveProperty(field);
      }

      expect(decision.decisionId).toMatch(/^DEC-\d+-[a-f0-9]{12}$/);
      expect(decision.metadata.ruleSetVersion).toBe('WP-DIF-01-v1.0');
      expect(decision.evidence).toEqual([{ canonicalId: 'skill-1', name: 'Python', nodeType: 'SKILL', matchedFrom: 'Python' }]);
      expect(decision.reasoningTrace).toMatchObject({
        validationResultRef: expect.stringContaining('user-1'),
        recommendationResponseRef: expect.stringContaining('user-1'),
      });
    });

    it('never includes an "outcome" or "context" field (not part of the frozen contract)', async () => {
      const engine = makeEngine();
      const decision = await engine.decide('user-1', 'skill');

      expect(decision).not.toHaveProperty('outcome');
      expect(decision).not.toHaveProperty('context');
    });

    it('generates a unique decisionId per call', async () => {
      const engine = makeEngine();
      const a = await engine.decide('user-1', 'skill');
      const b = await engine.decide('user-1', 'skill');

      expect(a.decisionId).not.toBe(b.decisionId);
    });

    it('decisionFactors lists every rule actually evaluated, in evaluation order, with an outcome', async () => {
      const engine = makeEngine();
      const decision = await engine.decide('user-1', 'skill');

      const ruleIds = decision.decisionFactors.map((f) => f.ruleId);
      expect(ruleIds).toEqual(['DR-TYP-01', 'DR-FAIR-01', 'DR-INT-01', 'DR-ESC-02', 'DR-ESC-01', 'DR-SUF-01', 'DR-SUF-02', 'DR-CNF-01', 'DR-PRI-01', 'DR-PRI-02']);
    });
  });

  // ─────────────────────────────────────────────────────────
  // REPOSITORY ISOLATION (ARB-01 Final Decision, Condition 4)
  // ─────────────────────────────────────────────────────────
  describe('Repository isolation (WP-ARB-01 Condition 4)', () => {
    it('DecisionEngine source imports no repository, Supabase, or SQL modules', () => {
      const source = fs.readFileSync(path.join(__dirname, '..', 'decision.service.js'), 'utf8');

      expect(source).not.toMatch(/require\(['"].*repository/i);
      expect(source).not.toMatch(/require\(['"]@supabase/i);
      expect(source).not.toMatch(/supabaseClient/i);
      expect(source).not.toMatch(/\bSELECT\s+\*|\bINSERT\s+INTO|\bUPDATE\s+\w+\s+SET/i);
      expect(source).not.toMatch(/console\.log/);
    });

    it('DecisionEngine only ever calls knowledgeService, studentService, recommendationService, validationService', async () => {
      const knowledgeService = makeKnowledgeService();
      const studentService = makeStudentService();
      const recommendationService = makeRecommendationService();
      const validationService = makeValidationService();
      const engine = new DecisionEngine({ knowledgeService, studentService, recommendationService, validationService, logger: makeLogger() });

      await engine.decide('user-1', 'skill');

      // knowledgeService is a required constructor dependency (Mission
      // statement) but is not called directly in v1 — see decision.service.js
      // module header. Its methods must remain untouched.
      expect(knowledgeService.searchKnowledge).not.toHaveBeenCalled();
      expect(validationService.validateDecisionReadiness).toHaveBeenCalled();
      expect(recommendationService.generateRecommendationCandidates).toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────
  // LOGGING
  // ─────────────────────────────────────────────────────────
  describe('Logging', () => {
    it('logs Decision Started, Validation Completed, Recommendation Completed, and Decision Completed for a successful skill decision', async () => {
      const logger = makeLogger();
      const engine = makeEngine({ logger });

      await engine.decide('user-1', 'skill');

      const infoMessages = logger.info.mock.calls.map((call) => call[0]);
      expect(infoMessages).toEqual(
        expect.arrayContaining([
          '[KnowledgeRuntime.Decision] Decision Started',
          '[KnowledgeRuntime.Decision] Validation Completed',
          '[KnowledgeRuntime.Decision] Recommendation Completed',
          '[KnowledgeRuntime.Decision] Decision Completed',
        ])
      );
    });

    it('logs Decision Withheld for a WITHHELD outcome', async () => {
      const logger = makeLogger();
      const validationService = makeValidationService({
        validateDecisionReadiness: jest.fn(async () => makeValidationResult({ errors: ['USER_ID_MISMATCH'] })),
      });
      const engine = makeEngine({ logger, validationService });

      await engine.decide('user-1', 'skill');

      const infoMessages = logger.info.mock.calls.map((call) => call[0]);
      expect(infoMessages).toContain('[KnowledgeRuntime.Decision] Decision Withheld');
    });

    it('logs Decision Failed and rethrows when a dependency throws unexpectedly', async () => {
      const logger = makeLogger();
      const validationService = makeValidationService({
        validateDecisionReadiness: jest.fn(async () => {
          throw new Error('downstream failure');
        }),
      });
      const engine = makeEngine({ logger, validationService });

      await expect(engine.decide('user-1', 'skill')).rejects.toThrow('downstream failure');

      const errorMessages = logger.error.mock.calls.map((call) => call[0]);
      expect(errorMessages).toContain('[KnowledgeRuntime.Decision] Decision Failed');
    });
  });
});