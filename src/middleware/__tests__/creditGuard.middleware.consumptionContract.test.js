'use strict';

/**
 * @file creditGuard.middleware.consumptionContract.test.js
 *
 * Phase 4A — Canonical Credit Consumption Defect — Fix + Verification.
 *
 * consume_ai_credits (supabase/migrations/000_initial_schema.sql,
 * 20260831000001_phase4_usage_credits_ledger.sql) is `RETURNS integer` —
 * a bare scalar remaining balance on success, or a raised exception on
 * every failure mode. It has never returned an object shaped
 * `{ success, remaining, ... }`.
 *
 * OLD (broken) creditGuard.middleware.js#normalizeCreditRpcResult()
 * expected exactly that nonexistent object shape, so:
 *   - every genuinely successful consumption (`data` = a plain number)
 *     was reported as `success: false` (`row?.success` on a number is
 *     `undefined`) — the user's balance was already decremented and a
 *     CONSUME ledger row already written by the RPC, but the request was
 *     then rejected with a 402 anyway;
 *   - a consumption that left the user at exactly 0 remaining credits
 *     hit the `if (!data) return { success: false }` branch even before
 *     that (since `!0` is `true`), independently mis-classified as
 *     failure;
 *   - genuine RPC-signalled insufficient-credit / invalid-amount
 *     exceptions were never actually routed through the intended
 *     `if (!result.success) → 402` branch at all — they threw straight
 *     to the middleware's generic outer catch → 500 "Credit validation
 *     failed", not the specific "Insufficient AI credits" 402 the code
 *     appears to intend.
 *
 * This suite pins the corrected contract for all of these paths. Every
 * "success" case below uses this test file's SUCCESS_DATA fixtures to
 * simulate what supabase-js actually hands back for a `RETURNS integer`
 * RPC (a bare number) — not the object shape the old code assumed — so
 * these tests fail under the pre-fix implementation.
 */

jest.mock('../../config/supabase', () => ({
  supabase: { rpc: jest.fn() },
}));
jest.mock('../../utils/logger', () => ({
  debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));
jest.mock('../../modules/analysis/analysis.constants', () => ({
  CREDIT_COSTS: { jobMatchAnalysis: 3 },
  isValidOperation: jest.fn(() => true),
}));
jest.mock('../requireTier.middleware', () => ({
  normalizeTier: jest.fn(() => 'pro'),
}));

const { supabase } = require('../../config/supabase');
const { creditGuard } = require('../creditGuard.middleware');

function mockReqRes(overrides = {}) {
  const req = { user: { uid: 'user-1', plan: 'pro' }, ...overrides };
  const res = {};
  const next = jest.fn();
  return { req, res, next };
}

function insufficientCreditsError(available) {
  const err = new Error(`INSUFFICIENT_CREDITS: required=3, available=${available}`);
  return err;
}

function invalidAmountError() {
  return new Error('INVALID_AMOUNT: amount must be a positive integer, got -3');
}

describe('creditGuard.middleware — consume_ai_credits return-contract fix (Phase 4A)', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('successful consumption (scalar RPC return — the actual contract)', () => {
    it('treats a bare-number success result as success:true with the correct remaining balance', async () => {
      supabase.rpc.mockResolvedValue({ data: 7, error: null }); // real shape: RETURNS integer

      const middleware = creditGuard('jobMatchAnalysis');
      const { req, res, next } = mockReqRes();
      await middleware(req, res, next);

      expect(next).toHaveBeenCalledWith(); // no error arg = success
      expect(req.creditsRemaining).toBe(7);
      expect(req.creditConsumption).toEqual(
        expect.objectContaining({ userId: 'user-1', operationType: 'jobMatchAnalysis', consumed: 3, remaining: 7 })
      );
    });

    it('treats a result that leaves exactly 0 credits remaining as success (regression: `!data` falsy-check bug)', async () => {
      supabase.rpc.mockResolvedValue({ data: 0, error: null });

      const middleware = creditGuard('jobMatchAnalysis');
      const { req, res, next } = mockReqRes();
      await middleware(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.creditsRemaining).toBe(0);
    });

    it('passes operationType as p_source on the consume_ai_credits call', async () => {
      supabase.rpc.mockResolvedValue({ data: 5, error: null });

      const middleware = creditGuard('jobMatchAnalysis');
      const { req, res, next } = mockReqRes();
      await middleware(req, res, next);

      expect(supabase.rpc).toHaveBeenCalledWith('consume_ai_credits', expect.objectContaining({
        p_user_id: 'user-1',
        p_amount: 3,
        p_source: 'jobMatchAnalysis',
      }));
    });
  });

  describe('insufficient balance (RPC raises INSUFFICIENT_CREDITS — a business outcome, not an infra failure)', () => {
    it('surfaces as a 402 "Insufficient AI credits" AppError, not a generic 500', async () => {
      supabase.rpc.mockResolvedValue({ data: null, error: insufficientCreditsError(1) });

      const middleware = creditGuard('jobMatchAnalysis');
      const { req, res, next } = mockReqRes();
      await middleware(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({
        statusCode: 402,
        message: 'Insufficient AI credits',
      }));
      expect(req.creditsRemaining).toBeUndefined(); // never set on rejection
    });

    it('reports the actual available balance parsed from the RPC message', async () => {
      supabase.rpc.mockResolvedValue({ data: null, error: insufficientCreditsError(1) });

      const middleware = creditGuard('jobMatchAnalysis');
      const { req, res, next } = mockReqRes();
      await middleware(req, res, next);

      const [err] = next.mock.calls[0];
      expect(err.metadata).toEqual(
        expect.objectContaining({ creditsAvailable: 1, creditsRequired: 3 })
      );
    });
  });

  describe('invalid amount (RPC raises INVALID_AMOUNT)', () => {
    it('surfaces as a rejection (success:false path), not a generic 500', async () => {
      supabase.rpc.mockResolvedValue({ data: null, error: invalidAmountError() });

      const middleware = creditGuard('jobMatchAnalysis');
      const { req, res, next } = mockReqRes();
      await middleware(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 402 }));
    });
  });

  describe('genuine RPC/database failure (must NOT be interpreted as insufficient credits or as success)', () => {
    it('propagates as a 500 "Credit validation failed", never as a 402 or as success', async () => {
      supabase.rpc.mockResolvedValue({ data: null, error: new Error('connection reset by peer') });

      const middleware = creditGuard('jobMatchAnalysis');
      const { req, res, next } = mockReqRes();
      await middleware(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 500 }));
      expect(next).not.toHaveBeenCalledWith(expect.objectContaining({ statusCode: 402 }));
      expect(req.creditsRemaining).toBeUndefined();
    });
  });

  describe('no duplicate ledger writes from the middleware', () => {
    it('calls consume_ai_credits exactly once per request — the middleware is a consumer of the ledger, not a second writer', async () => {
      supabase.rpc.mockResolvedValue({ data: 5, error: null });

      const middleware = creditGuard('jobMatchAnalysis');
      const { req, res, next } = mockReqRes();
      await middleware(req, res, next);

      expect(supabase.rpc).toHaveBeenCalledTimes(1);
    });
  });
});
