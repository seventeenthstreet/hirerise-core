'use strict';

/**
 * modules/knowledge-runtime/explainability/__tests__/explainability.service.test.js
 *
 * ExplainabilityRuntime is pure/deterministic — no mocks of upstream
 * services are needed; tests feed it plain Decision-shaped objects,
 * matching `decision.service.js`'s real `_assemble()` output shape.
 */

const ExplainabilityRuntime = require('../explainability.service');
const { RULE_LABELS, UNKNOWN_RULE_LABEL, SCHEMA_VERSION } = ExplainabilityRuntime;

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeDecision(overrides = {}) {
  return {
    decisionId: 'DEC-123-abc',
    timestamp: '2026-07-01T00:00:00.000Z',
    userId: 'user-1',
    decisionType: 'skill',
    status: 'DECISION_READY',
    confidence: 0.82,
    qualityScore: 0.8,
    priority: 'P2',
    recommendedActions: [],
    evidence: [{ canonicalId: 'skill-1', name: 'Python' }],
    reasoningTrace: { validationResultRef: 'user-1:ts', recommendationResponseRef: 'user-1:ts' },
    confidenceBreakdown: { bandLabel: 'High', inputs: {} },
    decisionFactors: [
      { ruleId: 'DR-TYP-01', evaluated: true, fired: false, outcome: 'PASSED', detail: null, note: null },
      { ruleId: 'DR-CNF-01', evaluated: true, fired: true, outcome: 'DECISION_READY', detail: null, note: null },
    ],
    metadata: { hkpSnapshotVersion: null, ruleSetVersion: 'WP-DIF-01-v1.0', knowledgeVersion: null },
    ...overrides,
  };
}

describe('ExplainabilityRuntime', () => {
  describe('constructor', () => {
    it('throws when logger is missing', () => {
      expect(() => new ExplainabilityRuntime({})).toThrow('[ExplainabilityRuntime] logger is required');
    });

    it('constructs with just a logger', () => {
      expect(() => new ExplainabilityRuntime({ logger: makeLogger() })).not.toThrow();
    });
  });

  describe('explain()', () => {
    it('throws when decision is missing or not an object', () => {
      const runtime = new ExplainabilityRuntime({ logger: makeLogger() });
      expect(() => runtime.explain(null)).toThrow('[ExplainabilityRuntime] decision is required and must be an object');
      expect(() => runtime.explain(undefined)).toThrow();
      expect(() => runtime.explain('not-an-object')).toThrow();
    });

    it('produces exactly the ten approved ExplanationPayload fields', () => {
      const runtime = new ExplainabilityRuntime({ logger: makeLogger() });
      const payload = runtime.explain(makeDecision());

      expect(Object.keys(payload).sort()).toEqual(
        [
          'schemaVersion',
          'decisionId',
          'decisionType',
          'generatedAt',
          'status',
          'headline',
          'confidence',
          'factors',
          'evidenceSummary',
          'metadata',
        ].sort()
      );
    });

    it('pass-throughs decisionId, decisionType, status, and timestamp (as generatedAt)', () => {
      const runtime = new ExplainabilityRuntime({ logger: makeLogger() });
      const payload = runtime.explain(makeDecision());

      expect(payload.decisionId).toBe('DEC-123-abc');
      expect(payload.decisionType).toBe('skill');
      expect(payload.status).toBe('DECISION_READY');
      expect(payload.generatedAt).toBe('2026-07-01T00:00:00.000Z');
      expect(payload.schemaVersion).toBe(SCHEMA_VERSION);
    });

    it('never includes userId anywhere in the payload', () => {
      const runtime = new ExplainabilityRuntime({ logger: makeLogger() });
      const payload = runtime.explain(makeDecision());

      expect(JSON.stringify(payload)).not.toContain('user-1');
    });

    describe('headline generation', () => {
      it.each([
        ['DECISION_READY', 'Decision is ready for release.'],
        ['PROVISIONAL', 'Decision is provisional, pending additional evidence.'],
        ['INSUFFICIENT_EVIDENCE', 'Insufficient evidence to reach a decision.'],
        ['ESCALATION_REQUIRED', 'Decision requires escalation to a counsellor.'],
        ['WITHHELD', 'Decision has been withheld.'],
      ])('maps status %s to a fixed headline', (status, expectedHeadline) => {
        const runtime = new ExplainabilityRuntime({ logger: makeLogger() });
        const payload = runtime.explain(makeDecision({ status }));
        expect(payload.headline).toBe(expectedHeadline);
      });

      it('falls back to a fixed unknown-status headline for an unrecognized status', () => {
        const runtime = new ExplainabilityRuntime({ logger: makeLogger() });
        const payload = runtime.explain(makeDecision({ status: 'SOMETHING_NEW' }));
        expect(payload.headline).toBe('Decision status is unrecognized.');
      });
    });

    describe('confidence summary', () => {
      it('reuses the existing score + IQF band label, introducing no new algorithm', () => {
        const runtime = new ExplainabilityRuntime({ logger: makeLogger() });
        const payload = runtime.explain(
          makeDecision({ confidence: 0.91, confidenceBreakdown: { bandLabel: 'Very High', inputs: {} } })
        );
        expect(payload.confidence).toEqual({ score: 0.91, band: 'Very High' });
      });

      it('returns null score/band when absent (e.g., WITHHELD from DR-TYP-01)', () => {
        const runtime = new ExplainabilityRuntime({ logger: makeLogger() });
        const payload = runtime.explain(
          makeDecision({ confidence: null, confidenceBreakdown: { bandLabel: null, inputs: {} } })
        );
        expect(payload.confidence).toEqual({ score: null, band: null });
      });
    });

    describe('rule mapping / factors', () => {
      it('maps every known ruleId to its static label and strips the raw ruleId', () => {
        const runtime = new ExplainabilityRuntime({ logger: makeLogger() });
        const allRuleIds = Object.keys(RULE_LABELS);
        const decision = makeDecision({
          decisionFactors: allRuleIds.map((ruleId) => ({ ruleId, evaluated: true, fired: false, outcome: null })),
        });

        const payload = runtime.explain(decision);

        expect(payload.factors).toHaveLength(allRuleIds.length);
        payload.factors.forEach((factor, i) => {
          expect(factor.label).toBe(RULE_LABELS[allRuleIds[i]]);
          expect(factor).not.toHaveProperty('ruleId');
        });
      });

      it('falls back to a fixed unknown-rule label for an unrecognized ruleId, without inventing one', () => {
        const runtime = new ExplainabilityRuntime({ logger: makeLogger() });
        const decision = makeDecision({
          decisionFactors: [{ ruleId: 'DR-DOES-NOT-EXIST', evaluated: true, fired: false, outcome: null }],
        });

        const payload = runtime.explain(decision);

        expect(payload.factors[0].label).toBe(UNKNOWN_RULE_LABEL);
      });

      it('preserves evaluation order from decisionFactors', () => {
        const runtime = new ExplainabilityRuntime({ logger: makeLogger() });
        const decision = makeDecision({
          decisionFactors: [
            { ruleId: 'DR-INT-01', evaluated: true, fired: false, outcome: 'A' },
            { ruleId: 'DR-SUF-01', evaluated: true, fired: false, outcome: 'B' },
            { ruleId: 'DR-CNF-01', evaluated: true, fired: true, outcome: 'C' },
          ],
        });

        const payload = runtime.explain(decision);

        expect(payload.factors.map((f) => f.outcome)).toEqual(['A', 'B', 'C']);
      });

      it('returns an empty array when decisionFactors is absent or not an array', () => {
        const runtime = new ExplainabilityRuntime({ logger: makeLogger() });
        expect(runtime.explain(makeDecision({ decisionFactors: undefined })).factors).toEqual([]);
        expect(runtime.explain(makeDecision({ decisionFactors: null })).factors).toEqual([]);
      });
    });

    describe('evidence summary', () => {
      it('reports availability=true and the correct count for non-empty evidence', () => {
        const runtime = new ExplainabilityRuntime({ logger: makeLogger() });
        const payload = runtime.explain(
          makeDecision({ evidence: [{ canonicalId: 'a' }, { canonicalId: 'b' }] })
        );
        expect(payload.evidenceSummary).toEqual({ available: true, count: 2 });
      });

      it('reports availability=false and count=0 for empty or missing evidence', () => {
        const runtime = new ExplainabilityRuntime({ logger: makeLogger() });
        expect(runtime.explain(makeDecision({ evidence: [] })).evidenceSummary).toEqual({ available: false, count: 0 });
        expect(runtime.explain(makeDecision({ evidence: undefined })).evidenceSummary).toEqual({ available: false, count: 0 });
      });

      it('never exposes the raw evidence array itself', () => {
        const runtime = new ExplainabilityRuntime({ logger: makeLogger() });
        const payload = runtime.explain(makeDecision());
        expect(payload.evidenceSummary).not.toHaveProperty('items');
        expect(payload.evidenceSummary).not.toHaveProperty('evidence');
        expect(Object.keys(payload.evidenceSummary).sort()).toEqual(['available', 'count']);
      });
    });

    describe('metadata', () => {
      it('surfaces only ruleSetVersion and rule-firing counts, no internal fields', () => {
        const runtime = new ExplainabilityRuntime({ logger: makeLogger() });
        const payload = runtime.explain(makeDecision());
        expect(payload.metadata).toEqual({ ruleSetVersion: 'WP-DIF-01-v1.0', factorCount: 2, firedFactorCount: 1 });
      });

      it('never exposes hkpSnapshotVersion or knowledgeVersion (internal-only)', () => {
        const runtime = new ExplainabilityRuntime({ logger: makeLogger() });
        const payload = runtime.explain(
          makeDecision({ metadata: { hkpSnapshotVersion: 'v9', ruleSetVersion: 'X', knowledgeVersion: 'v3' } })
        );
        expect(payload.metadata).not.toHaveProperty('hkpSnapshotVersion');
        expect(payload.metadata).not.toHaveProperty('knowledgeVersion');
      });
    });

    describe('determinism / regression', () => {
      it('produces a structurally and value-identical payload across repeated calls on the same Decision', () => {
        const runtime = new ExplainabilityRuntime({ logger: makeLogger() });
        const decision = makeDecision();

        const first = runtime.explain(decision);
        const second = runtime.explain(decision);
        const third = runtime.explain(makeDecision()); // fresh but value-equal object

        expect(second).toEqual(first);
        expect(third).toEqual(first);
      });

      it('returns a frozen payload and frozen sub-objects', () => {
        const runtime = new ExplainabilityRuntime({ logger: makeLogger() });
        const payload = runtime.explain(makeDecision());

        expect(Object.isFrozen(payload)).toBe(true);
        expect(Object.isFrozen(payload.confidence)).toBe(true);
        expect(Object.isFrozen(payload.factors)).toBe(true);
        expect(Object.isFrozen(payload.evidenceSummary)).toBe(true);
        expect(Object.isFrozen(payload.metadata)).toBe(true);
      });

      it('performs no repository, database, API, or AI access (pure function of its argument)', () => {
        const logger = makeLogger();
        const runtime = new ExplainabilityRuntime({ logger });
        expect(() => runtime.explain(makeDecision())).not.toThrow();
        // Only logging occurred; no other injected collaborator exists on
        // the instance to have been called.
        expect(Object.keys(runtime)).toEqual(['_logger', '_config']);
      });
    });
  });
});
