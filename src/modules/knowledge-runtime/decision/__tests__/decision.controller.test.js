'use strict';

/**
 * modules/knowledge-runtime/decision/__tests__/decision.controller.test.js
 *
 * WP-IMP-06: extended to cover ExplainabilityRuntime integration — the
 * controller now also calls `getExplainabilityService().explain(decision)`
 * and attaches the result as `data.explanation`, while every previously
 * existing Decision field on `data` remains unchanged (backward compatible
 * envelope).
 */

const mockDecisionService = {
  decide: jest.fn(),
};

const mockExplainabilityService = {
  explain: jest.fn(),
};

jest.mock('../../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../../knowledge-runtime.module', () => ({
  getDecisionService: () => mockDecisionService,
  getExplainabilityService: () => mockExplainabilityService,
}));

const controller = require('../decision.controller');

function makeRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

describe('decision.controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('decideMine', () => {
    it('resolves userId from req.user.id and decisionType from the query string, then calls the service', async () => {
      mockDecisionService.decide.mockResolvedValue({ decisionId: 'DEC-1', status: 'DECISION_READY' });
      mockExplainabilityService.explain.mockReturnValue({ decisionId: 'DEC-1', headline: 'Decision is ready for release.' });
      const req = { user: { id: 'user-1' }, query: { decisionType: 'skill' } };
      const res = makeRes();
      const next = jest.fn();

      await controller.decideMine(req, res, next);

      expect(mockDecisionService.decide).toHaveBeenCalledWith('user-1', 'skill');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: {
          decisionId: 'DEC-1',
          status: 'DECISION_READY',
          explanation: { decisionId: 'DEC-1', headline: 'Decision is ready for release.' },
        },
      });
    });

    it('invokes ExplainabilityRuntime with the exact Decision object returned by DecisionEngine', async () => {
      const decision = { decisionId: 'DEC-2', status: 'PROVISIONAL' };
      mockDecisionService.decide.mockResolvedValue(decision);
      mockExplainabilityService.explain.mockReturnValue({ decisionId: 'DEC-2', headline: 'Decision is provisional, pending additional evidence.' });
      const req = { user: { id: 'user-1' }, query: { decisionType: 'skill' } };
      const res = makeRes();
      const next = jest.fn();

      await controller.decideMine(req, res, next);

      expect(mockExplainabilityService.explain).toHaveBeenCalledWith(decision);
    });

    it('preserves every existing Decision field on data while adding explanation', async () => {
      const decision = {
        decisionId: 'DEC-3',
        timestamp: '2026-07-01T00:00:00.000Z',
        decisionType: 'skill',
        status: 'DECISION_READY',
        confidence: 0.8,
        qualityScore: 0.8,
        priority: 'P2',
        recommendedActions: [],
        evidence: [],
        reasoningTrace: {},
        confidenceBreakdown: {},
        decisionFactors: [],
        metadata: {},
      };
      mockDecisionService.decide.mockResolvedValue(decision);
      mockExplainabilityService.explain.mockReturnValue({ decisionId: 'DEC-3', headline: 'Decision is ready for release.' });
      const req = { user: { id: 'user-1' }, query: { decisionType: 'skill' } };
      const res = makeRes();
      const next = jest.fn();

      await controller.decideMine(req, res, next);

      const [{ data }] = res.json.mock.calls[0];
      expect(data).toMatchObject(decision);
      expect(data.explanation).toEqual({ decisionId: 'DEC-3', headline: 'Decision is ready for release.' });
    });

    it('forwards a validation error to next() when req.user is missing', async () => {
      const req = { user: undefined, query: { decisionType: 'skill' } };
      const res = makeRes();
      const next = jest.fn();

      await controller.decideMine(req, res, next);

      expect(mockDecisionService.decide).not.toHaveBeenCalled();
      expect(mockExplainabilityService.explain).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });

    it('forwards a validation error to next() when decisionType is missing', async () => {
      const req = { user: { id: 'user-1' }, query: {} };
      const res = makeRes();
      const next = jest.fn();

      await controller.decideMine(req, res, next);

      expect(mockDecisionService.decide).not.toHaveBeenCalled();
      expect(mockExplainabilityService.explain).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });

    it('forwards a validation error to next() when decisionType is not recognized', async () => {
      const req = { user: { id: 'user-1' }, query: { decisionType: 'placement' } };
      const res = makeRes();
      const next = jest.fn();

      await controller.decideMine(req, res, next);

      expect(mockDecisionService.decide).not.toHaveBeenCalled();
      expect(mockExplainabilityService.explain).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });

    it('forwards decision service errors to next() without calling ExplainabilityRuntime', async () => {
      mockDecisionService.decide.mockRejectedValue(new Error('boom'));
      const req = { user: { id: 'user-1' }, query: { decisionType: 'skill' } };
      const res = makeRes();
      const next = jest.fn();

      await controller.decideMine(req, res, next);

      expect(mockExplainabilityService.explain).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });

    it('forwards ExplainabilityRuntime errors to next()', async () => {
      mockDecisionService.decide.mockResolvedValue({ decisionId: 'DEC-4', status: 'DECISION_READY' });
      mockExplainabilityService.explain.mockImplementation(() => {
        throw new Error('explain failed');
      });
      const req = { user: { id: 'user-1' }, query: { decisionType: 'skill' } };
      const res = makeRes();
      const next = jest.fn();

      await controller.decideMine(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(res.json).not.toHaveBeenCalled();
    });
  });

  describe('decideMine — WP-SEC-01 Public Decision API Contract', () => {
    it('never includes userId in the client-facing response', async () => {
      mockDecisionService.decide.mockResolvedValue({
        decisionId: 'DEC-5',
        userId: 'user-1',
        status: 'DECISION_READY',
      });
      mockExplainabilityService.explain.mockReturnValue({ decisionId: 'DEC-5' });
      const req = { user: { id: 'user-1' }, query: { decisionType: 'skill' } };
      const res = makeRes();
      const next = jest.fn();

      await controller.decideMine(req, res, next);

      const [{ data }] = res.json.mock.calls[0];
      expect(data.userId).toBeUndefined();
      expect(JSON.stringify(data)).not.toContain('user-1');
    });

    it('replaces decisionFactors[].ruleId with the equivalent label and drops ruleId', async () => {
      mockDecisionService.decide.mockResolvedValue({
        decisionId: 'DEC-6',
        status: 'DECISION_READY',
        decisionFactors: [
          { ruleId: 'DR-INT-01', evaluated: true, fired: false, outcome: null, detail: null, note: null },
          { ruleId: 'DR-UNKNOWN-99', evaluated: true, fired: true, outcome: 'x', detail: null, note: null },
        ],
      });
      mockExplainabilityService.explain.mockReturnValue({ decisionId: 'DEC-6' });
      const req = { user: { id: 'user-1' }, query: { decisionType: 'skill' } };
      const res = makeRes();
      const next = jest.fn();

      await controller.decideMine(req, res, next);

      const [{ data }] = res.json.mock.calls[0];
      expect(data.decisionFactors).toEqual([
        { evaluated: true, fired: false, outcome: null, detail: null, note: null, label: 'Structural contract integrity check' },
        { evaluated: true, fired: true, outcome: 'x', detail: null, note: null, label: 'Unrecognized decision rule' },
      ]);
      expect(data.decisionFactors.every((factor) => !('ruleId' in factor))).toBe(true);
    });

    it('reshapes reasoningTrace to remove the embedded userId while preserving the timestamp reference', async () => {
      mockDecisionService.decide.mockResolvedValue({
        decisionId: 'DEC-7',
        status: 'DECISION_READY',
        reasoningTrace: {
          validationResultRef: 'user-1:2026-07-01T00:00:00.000Z',
          recommendationResponseRef: 'user-1:2026-07-01T00:00:01.000Z',
        },
      });
      mockExplainabilityService.explain.mockReturnValue({ decisionId: 'DEC-7' });
      const req = { user: { id: 'user-1' }, query: { decisionType: 'skill' } };
      const res = makeRes();
      const next = jest.fn();

      await controller.decideMine(req, res, next);

      const [{ data }] = res.json.mock.calls[0];
      expect(data.reasoningTrace).toEqual({
        validationResultRef: '2026-07-01T00:00:00.000Z',
        recommendationResponseRef: '2026-07-01T00:00:01.000Z',
      });
      expect(JSON.stringify(data.reasoningTrace)).not.toContain('user-1');
    });

    it('leaves a null reasoningTrace ref (e.g. no recommendationResponseRef) unchanged', async () => {
      mockDecisionService.decide.mockResolvedValue({
        decisionId: 'DEC-8',
        status: 'WITHHELD',
        reasoningTrace: {
          validationResultRef: 'user-1:2026-07-01T00:00:00.000Z',
          recommendationResponseRef: null,
        },
      });
      mockExplainabilityService.explain.mockReturnValue({ decisionId: 'DEC-8' });
      const req = { user: { id: 'user-1' }, query: { decisionType: 'skill' } };
      const res = makeRes();
      const next = jest.fn();

      await controller.decideMine(req, res, next);

      const [{ data }] = res.json.mock.calls[0];
      expect(data.reasoningTrace.recommendationResponseRef).toBeNull();
    });

    it('leaves metadata, explanation, and all other fields unchanged', async () => {
      const metadata = Object.freeze({ ruleSetVersion: 'WP-DIF-01-v1.0', hkpSnapshotVersion: null, knowledgeVersion: null });
      mockDecisionService.decide.mockResolvedValue({
        decisionId: 'DEC-9',
        status: 'DECISION_READY',
        metadata,
      });
      mockExplainabilityService.explain.mockReturnValue({ decisionId: 'DEC-9', headline: 'Decision is ready for release.' });
      const req = { user: { id: 'user-1' }, query: { decisionType: 'skill' } };
      const res = makeRes();
      const next = jest.fn();

      await controller.decideMine(req, res, next);

      const [{ data }] = res.json.mock.calls[0];
      expect(data.metadata).toEqual(metadata);
      expect(data.explanation).toEqual({ decisionId: 'DEC-9', headline: 'Decision is ready for release.' });
    });
  });
});
