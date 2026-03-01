'use strict';

/**
 * analysis.constants.js
 *
 * Central configuration for all weighted credit costs.
 * ONE place to adjust costs — changes propagate everywhere.
 *
 * MARGIN PROTECTION MATH (₹15 estimated cost per credit):
 *   ₹499 → floor(499 × 0.50 / 15) = 16 credits
 *   ₹699 → floor(699 × 0.50 / 15) = 23 credits
 *   ₹999 → floor(999 × 0.50 / 15) = 33 credits
 */

// ─── Credit cost per operation ────────────────────────────────
const CREDIT_COSTS = {
  fullAnalysis:  2,   // score + CHI + growth + salary (consolidated)
  careerReport:  2,   // onboarding AI career report — matches tierQuota key
  generateCV:    3,   // standalone general CV generation
  jobMatchAnalysis: 2,  // JD match score + gap analysis + suggestions
  jobSpecificCV: 3,   // tailored CV for a specific JD (longer output)
  chiCalculation: 1,   // standalone CHI calculation
};

// ─── Plan → credit allocation ─────────────────────────────────
const COST_PER_CREDIT_INR = 15;

const PLAN_CREDITS = {
  499: 16,
  699: 23,
  999: 33,
};

// ─── Helpers ──────────────────────────────────────────────────

function getCreditsForPlan(planAmount) {
  const credits = PLAN_CREDITS[planAmount];
  if (credits === undefined) {
    throw new Error(`Unknown plan amount: ${planAmount}`);
  }
  return credits;
}

function isValidOperation(operationType) {
  return Object.prototype.hasOwnProperty.call(CREDIT_COSTS, operationType);
}

/**
 * getRemainingUses(creditsRemaining)
 *
 * Returns how many times a user can run each operation with their current credits.
 * Used by /users/me to show frontend what the user can still do.
 *
 * @param {number} creditsRemaining
 * @returns {Record<string, number>}
 */
function getRemainingUses(creditsRemaining) {
  const credits = creditsRemaining ?? 0;
  const result  = {};
  for (const [op, cost] of Object.entries(CREDIT_COSTS)) {
    result[op] = Math.floor(credits / cost);
  }
  return result;
}

module.exports = {
  CREDIT_COSTS,
  COST_PER_CREDIT_INR,
  PLAN_CREDITS,
  getCreditsForPlan,
  isValidOperation,
  getRemainingUses,
};
