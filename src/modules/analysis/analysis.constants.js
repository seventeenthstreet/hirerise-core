'use strict';

/**
 * src/modules/analysis/analysis.constants.js
 *
 * Production-grade Supabase-backed monetization config.
 * Uses DB config with safe local fallback defaults.
 */

const DEFAULT_CREDIT_COSTS = Object.freeze({
  fullAnalysis: 2,
  careerReport: 2,
  generateCV: 3,
  jobMatchAnalysis: 2,
  jobSpecificCV: 3,
  chiCalculation: 1,
});

const DEFAULT_PLAN_CREDITS = Object.freeze({
  499: 16,
  699: 23,
  999: 33,
});

const COST_PER_CREDIT_INR = 15;

function createConfigResolver({ creditCostCache, planCache }) {
  function getCreditCosts() {
    return Object.keys(creditCostCache || {}).length
      ? { ...DEFAULT_CREDIT_COSTS, ...creditCostCache }
      : DEFAULT_CREDIT_COSTS;
  }

  function getPlanCredits() {
    return Object.keys(planCache || {}).length
      ? { ...DEFAULT_PLAN_CREDITS, ...planCache }
      : DEFAULT_PLAN_CREDITS;
  }

  function getCreditsForPlan(planAmount) {
    const plans = getPlanCredits();
    const credits = plans[Number(planAmount)];

    if (credits == null) {
      throw new Error(`Unknown plan amount: ${planAmount}`);
    }

    return credits;
  }

  function isValidOperation(operationType) {
    const costs = getCreditCosts();
    return Object.prototype.hasOwnProperty.call(costs, operationType);
  }

  function getRemainingUses(creditsRemaining) {
    const costs = getCreditCosts();
    const safeCredits = Math.max(Number(creditsRemaining) || 0, 0);
    const result = {};

    for (const [operation, cost] of Object.entries(costs)) {
      result[operation] = Math.floor(safeCredits / cost);
    }

    return result;
  }

  return {
    getCreditCosts,
    getPlanCredits,
    getCreditsForPlan,
    isValidOperation,
    getRemainingUses,
  };
}

module.exports = {
  DEFAULT_CREDIT_COSTS,
  DEFAULT_PLAN_CREDITS,
  COST_PER_CREDIT_INR,
  createConfigResolver,
};