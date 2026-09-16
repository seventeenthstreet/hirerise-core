'use strict';

/**
 * @file creditGuard.middleware.zeroCost.test.js
 *
 * HireRise Student MVP — `studentRecommendation = 0` CreditGuard correction.
 *
 * Prior read-only audit ("HireRise studentRecommendation = 0 CreditGuard —
 * Controlled Technical Decision Audit") found:
 *   - `studentRecommendation` was absent from DEFAULT_CREDIT_COSTS;
 *   - creditGuard.middleware.js rejected any configured cost `<= 0`,
 *     which would have blocked this operation even once registered;
 *   - the fix must not let a zero-cost operation reach
 *     checkAndDeductCredits()/consume_ai_credits, and must not weaken
 *     validation for existing paid operations or unknown operations.
 *
 * Unlike the other creditGuard test files in this directory, this suite
 * deliberately does NOT mock `../../modules/analysis/analysis.constants`.
 * It exercises the real DEFAULT_CREDIT_COSTS / isValidOperation() so that
 * the zero-cost registration and the paid-operation regression are both
 * verified against the actual production registry, not a stand-in.
 */

jest.mock('../../config/supabase', () => ({
  supabase: { rpc: jest.fn() },
}));
jest.mock('../../utils/logger', () => ({
  debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));
jest.mock('../requireTier.middleware', () => ({
  normalizeTier: jest.fn(() => 'pro'),
}));

const { supabase } = require('../../config/supabase');
const { creditGuard } = require('../creditGuard.middleware');
const { DEFAULT_CREDIT_COSTS } = require('../../modules/analysis/analysis.constants');

function mockReqRes(overrides = {}) {
  const req = { user: { uid: 'user-1', plan: 'pro' }, ...overrides };
  const res = {};
  const next = jest.fn();
  return { req, res, next };
}

describe('creditGuard.middleware — studentRecommendation zero-cost correction (real registry)', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('registration', () => {
    it('registers studentRecommendation at cost 0 in the real DEFAULT_CREDIT_COSTS', () => {
      expect(DEFAULT_CREDIT_COSTS).toHaveProperty('studentRecommendation', 0);
    });
  });

  describe('zero-cost operation (studentRecommendation)', () => {
    it('calls next() with no error', async () => {
      const middleware = creditGuard('studentRecommendation');
      const { req, res, next } = mockReqRes();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalledWith();
    });

    it('never calls the consume_ai_credits RPC (does not reach checkAndDeductCredits)', async () => {
      const middleware = creditGuard('studentRecommendation');
      const { req, res, next } = mockReqRes();

      await middleware(req, res, next);

      expect(supabase.rpc).not.toHaveBeenCalled();
    });

    it('attaches zero-cost request metadata', async () => {
      const middleware = creditGuard('studentRecommendation');
      const { req, res, next } = mockReqRes();

      await middleware(req, res, next);

      expect(req.creditCost).toBe(0);
      expect(req.creditConsumption).toMatchObject({
        operationType: 'studentRecommendation',
        consumed: 0,
      });
    });
  });

  describe('existing paid operation regression (fullAnalysis, real registry)', () => {
    it('still resolves its configured positive cost and invokes the deduction RPC', async () => {
      supabase.rpc.mockResolvedValue({ data: 8, error: null }); // RETURNS integer contract

      const middleware = creditGuard('fullAnalysis');
      const { req, res, next } = mockReqRes();

      await middleware(req, res, next);

      expect(supabase.rpc).toHaveBeenCalledWith('consume_ai_credits', expect.objectContaining({
        p_user_id: 'user-1',
        p_amount: DEFAULT_CREDIT_COSTS.fullAnalysis,
        p_source: 'fullAnalysis',
      }));
      expect(req.creditCost).toBe(DEFAULT_CREDIT_COSTS.fullAnalysis);
      expect(next).toHaveBeenCalledWith();
    });

    it('still returns 402 Insufficient AI credits when the RPC reports insufficient balance', async () => {
      supabase.rpc.mockResolvedValue({
        data: null,
        error: { message: 'INSUFFICIENT_CREDITS available=0', code: 'P0001' },
      });

      const middleware = creditGuard('fullAnalysis');
      const { req, res, next } = mockReqRes();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 402 }));
    });
  });

  describe('unknown operation', () => {
    it('remains rejected with 400, without ever calling the RPC', async () => {
      const middleware = creditGuard('totallyUnregisteredOperation');
      const { req, res, next } = mockReqRes();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
      expect(supabase.rpc).not.toHaveBeenCalled();
    });
  });
});
