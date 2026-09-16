'use strict';

/**
 * @file creditGuard.middleware.invalidCostConfig.test.js
 *
 * HireRise Student MVP — `studentRecommendation = 0` CreditGuard correction.
 *
 * The real DEFAULT_CREDIT_COSTS registry (see
 * creditGuard.middleware.zeroCost.test.js) has no negative or missing
 * cost entries to exercise — those are misconfiguration states that
 * cannot arise from the real registry today. This suite uses a small,
 * scoped mock of `../../modules/analysis/analysis.constants` (consistent
 * with the pattern already used by the other creditGuard test files in
 * this directory) purely to construct those otherwise-unreachable states,
 * and confirms the narrowed validation (`cost < 0` / non-finite) still
 * rejects them exactly as the pre-correction `cost <= 0` check did —
 * only a registered `0` is newly permitted.
 */

jest.mock('../../config/supabase', () => ({
  supabase: { rpc: jest.fn() },
}));
jest.mock('../../utils/logger', () => ({
  debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));
jest.mock('../../modules/analysis/analysis.constants', () => ({
  CREDIT_COSTS: {
    negativeCostOp: -1,
    missingCostOp: undefined,
    nonNumericCostOp: 'not-a-number',
  },
  // Real isValidOperation() checks key presence; these keys are present
  // in this scoped fake map, so the real validator's semantics are
  // preserved without needing to fake it.
  isValidOperation: (operationType) =>
    Object.prototype.hasOwnProperty.call(
      {
        negativeCostOp: -1,
        missingCostOp: undefined,
        nonNumericCostOp: 'not-a-number',
      },
      operationType
    ),
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

describe('creditGuard.middleware — invalid configured cost remains rejected', () => {
  beforeEach(() => jest.clearAllMocks());

  it('rejects a negative configured cost with 500 "Credit configuration invalid"', async () => {
    const middleware = creditGuard('negativeCostOp');
    const { req, res, next } = mockReqRes();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 500,
      message: 'Credit configuration invalid',
    }));
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('rejects a missing/undefined configured cost with 500 "Credit configuration invalid"', async () => {
    const middleware = creditGuard('missingCostOp');
    const { req, res, next } = mockReqRes();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 500,
      message: 'Credit configuration invalid',
    }));
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric configured cost with 500 "Credit configuration invalid"', async () => {
    const middleware = creditGuard('nonNumericCostOp');
    const { req, res, next } = mockReqRes();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 500,
      message: 'Credit configuration invalid',
    }));
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});
