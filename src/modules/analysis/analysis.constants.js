'use strict';

/**
 * src/modules/analysis/analysis.constants.js
 *
 * Production-grade monetization config.
 * Uses DB-loaded config with safe local fallback defaults.
 *
 * FIX: Added top-level CREDIT_COSTS export and standalone isValidOperation()
 * so creditGuard.middleware can import them directly without instantiating
 * a config resolver. Previously these were only accessible via createConfigResolver(),
 * causing `CREDIT_COSTS` to be `undefined` and `isValidOperation` to throw on import.
 */

const DEFAULT_CREDIT_COSTS = Object.freeze({
  fullAnalysis:    2,
  careerReport:    2,
  generateCV:      3,
  jobMatchAnalysis: 2,
  jobSpecificCV:   3,
  chiCalculation:  1,
});

const DEFAULT_PLAN_CREDITS = Object.freeze({
  499: 16,
  699: 23,
  999: 33,
});

const COST_PER_CREDIT_INR = 15;

// ─────────────────────────────────────────────────────────────────────────────
// Top-level exports (consumed by creditGuard.middleware directly)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Live credit costs. Starts as the default map; callers that load DB config
 * via createConfigResolver() work against their own merged copy.
 * creditGuard.middleware uses this reference for a fast synchronous lookup.
 */
const CREDIT_COSTS = DEFAULT_CREDIT_COSTS;

/**
 * Standalone operation validator — does NOT require a resolver instance.
 * Returns true when operationType is a recognised billable operation.
 */
function isValidOperation(operationType) {
  return Object.prototype.hasOwnProperty.call(DEFAULT_CREDIT_COSTS, operationType);
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolver factory (for services that load dynamic DB config)
// ─────────────────────────────────────────────────────────────────────────────

function createConfigResolver({ creditCostCache = {}, planCache = {} } = {}) {
  function getCreditCosts() {
    return Object.keys(creditCostCache).length
      ? { ...DEFAULT_CREDIT_COSTS, ...creditCostCache }
      : DEFAULT_CREDIT_COSTS;
  }

  function getPlanCredits() {
    return Object.keys(planCache).length
      ? { ...DEFAULT_PLAN_CREDITS, ...planCache }
      : DEFAULT_PLAN_CREDITS;
  }

  function getCreditsForPlan(planAmount) {
    const plans   = getPlanCredits();
    const credits = plans[Number(planAmount)];

    if (credits == null) {
      throw new Error(`Unknown plan amount: ${planAmount}`);
    }

    return credits;
  }

  function resolverIsValidOperation(operationType) {
    const costs = getCreditCosts();
    return Object.prototype.hasOwnProperty.call(costs, operationType);
  }

  function getRemainingUses(creditsRemaining) {
    const costs      = getCreditCosts();
    const safeCredits = Math.max(Number(creditsRemaining) || 0, 0);
    const result     = {};

    for (const [operation, cost] of Object.entries(costs)) {
      result[operation] = Math.floor(safeCredits / cost);
    }

    return result;
  }

  return {
    getCreditCosts,
    getPlanCredits,
    getCreditsForPlan,
    isValidOperation: resolverIsValidOperation,
    getRemainingUses,
  };
}

module.exports = {
  DEFAULT_CREDIT_COSTS,
  DEFAULT_PLAN_CREDITS,
  COST_PER_CREDIT_INR,
  CREDIT_COSTS,        // ← FIXED: direct export for creditGuard.middleware
  isValidOperation,    // ← FIXED: standalone export
  createConfigResolver,
};
