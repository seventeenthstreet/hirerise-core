'use strict';

/**
 * @file analysis.constants.studentRecommendation.test.js
 *
 * HireRise Student MVP — `studentRecommendation = 0` CreditGuard correction.
 *
 * Covers the two changes made to analysis.constants.js:
 *   1. `studentRecommendation: 0` is now a registered operation in
 *      DEFAULT_CREDIT_COSTS, so isValidOperation('studentRecommendation')
 *      is true (it previously was not registered at all — see the prior
 *      audit).
 *   2. Both getRemainingUses() implementations (the standalone export and
 *      the one returned by createConfigResolver()) must not divide by a
 *      zero-cost operation's cost — they must report `null` (this
 *      codebase's existing "unmetered" convention, matching
 *      TIER_MONTHLY_QUOTAS's `default: null` in tierquota.middleware.js)
 *      instead of `Infinity`/`NaN`.
 *
 * Existing paid-operation costs and remaining-uses arithmetic are
 * asserted unchanged.
 */

const {
  DEFAULT_CREDIT_COSTS,
  isValidOperation,
  getRemainingUses,
  createConfigResolver,
} = require('../analysis.constants');

describe('analysis.constants — studentRecommendation registration', () => {
  it('registers studentRecommendation at cost 0', () => {
    expect(DEFAULT_CREDIT_COSTS.studentRecommendation).toBe(0);
  });

  it('does not change any existing paid operation cost', () => {
    expect(DEFAULT_CREDIT_COSTS).toMatchObject({
      fullAnalysis:    2,
      careerReport:    2,
      generateCV:      3,
      jobMatchAnalysis: 2,
      jobSpecificCV:   3,
      chiCalculation:  1,
      jobMatchPremium: 2,
    });
  });

  it('isValidOperation recognizes studentRecommendation as valid', () => {
    expect(isValidOperation('studentRecommendation')).toBe(true);
  });

  it('isValidOperation still rejects an unregistered operation', () => {
    expect(isValidOperation('someUnregisteredOperation')).toBe(false);
  });
});

describe('analysis.constants — getRemainingUses() zero-cost safety (standalone export)', () => {
  it('reports null (not Infinity) for studentRecommendation regardless of balance', () => {
    const result = getRemainingUses(50);
    expect(result.studentRecommendation).toBeNull();
  });

  it('reports null (not NaN) for studentRecommendation when balance is 0', () => {
    const result = getRemainingUses(0);
    expect(result.studentRecommendation).toBeNull();
  });

  it('leaves existing paid-operation arithmetic unchanged', () => {
    const result = getRemainingUses(10);
    expect(result.chiCalculation).toBe(10);       // cost 1
    expect(result.fullAnalysis).toBe(5);           // cost 2
    expect(result.generateCV).toBe(3);             // cost 3, floor(10/3)
  });

  it('accepts a user doc shape and never returns Infinity/NaN for any operation', () => {
    const result = getRemainingUses({ aiCreditsRemaining: 7 });
    for (const value of Object.values(result)) {
      expect(Number.isFinite(value) || value === null).toBe(true);
    }
  });
});

describe('analysis.constants — getRemainingUses() zero-cost safety (createConfigResolver)', () => {
  it('reports null for studentRecommendation via the resolver factory too', () => {
    const resolver = createConfigResolver();
    const result = resolver.getRemainingUses(25);
    expect(result.studentRecommendation).toBeNull();
  });

  it('never returns Infinity/NaN for any operation, including with an override cache', () => {
    const resolver = createConfigResolver({ creditCostCache: { fullAnalysis: 4 } });
    const result = resolver.getRemainingUses(0);
    for (const value of Object.values(result)) {
      expect(Number.isFinite(value) || value === null).toBe(true);
    }
    expect(result.fullAnalysis).toBe(0);
    expect(result.studentRecommendation).toBeNull();
  });
});
