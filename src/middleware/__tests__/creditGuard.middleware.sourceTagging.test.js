'use strict';

/**
 * @file creditGuard.middleware.sourceTagging.test.js
 *
 * Phase 4 Usage/Credits Contract Lock — ledger "source" enrichment.
 * creditGuard.middleware.js already called the canonical consume_ai_credits
 * RPC before this phase; the only change here is passing the operationType
 * it already has as p_source, so CONSUME ledger rows written by any
 * credit-guarded route are attributable to a real feature identifier
 * (Phase 3 Contract §6 "Source" — "use actual existing source identifiers
 * where available") instead of being unlabeled.
 *
 * NOTE — pre-existing, out-of-scope finding (not fixed here per contract
 * §35 "do not reopen decisions already locked" / no scope expansion):
 * normalizeCreditRpcResult() expects an object shaped like
 * { success, remaining, ... }, but consume_ai_credits (both before and
 * after this phase) RETURNS integer — a bare scalar. Supabase-js
 * therefore hands this function a plain number, so `row?.success` is
 * always undefined and result.success is always false. This suite
 * documents that actual current behavior rather than an idealized one;
 * flagged separately in the Phase 4 implementation report as a
 * discovered defect outside the locked Usage/Credits scope, since fixing
 * this middleware's result-parsing is not one of the eight approved
 * implementation steps.
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

describe('creditGuard.middleware — ledger source tagging', () => {
  beforeEach(() => jest.clearAllMocks());

  it('passes operationType as p_source on the consume_ai_credits call', async () => {
    supabase.rpc.mockResolvedValue({ data: { success: true, remaining: 5 }, error: null });

    const middleware = creditGuard('jobMatchAnalysis');
    const { req, res, next } = mockReqRes();

    await middleware(req, res, next);

    expect(supabase.rpc).toHaveBeenCalledWith('consume_ai_credits', expect.objectContaining({
      p_user_id: 'user-1',
      p_amount: 3,
      p_source: 'jobMatchAnalysis',
    }));
  });

  it('still calls next() with no error on an object-shaped success result', async () => {
    supabase.rpc.mockResolvedValue({ data: { success: true, remaining: 5 }, error: null });

    const middleware = creditGuard('jobMatchAnalysis');
    const { req, res, next } = mockReqRes();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledWith(); // called with no args = success
  });

  it('propagates the RPC error via next(err) on failure', async () => {
    supabase.rpc.mockResolvedValue({ data: null, error: new Error('db exploded') });

    const middleware = creditGuard('jobMatchAnalysis');
    const { req, res, next } = mockReqRes();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 500 }));
  });
});
