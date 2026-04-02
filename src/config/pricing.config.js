'use strict';

/**
 * pricing.config.js (HARDENED + UNIFIED)
 *
 * ✅ Unified cost logic
 * ✅ Validation layer
 * ✅ Safe access helpers
 * ✅ Configurable FX rate
 * ✅ Margin threshold fix
 */

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────

// ✅ SINGLE SOURCE OF TRUTH: per MILLION tokens
const UNIT = 'per_million_tokens';

const MODEL_PRICING = {
  'claude-opus-4-6':          { input: 15.0, output: 75.0 },
  'claude-sonnet-4-20250514': { input: 3.0,  output: 15.0 },

  'claude-3-5-sonnet': { input: 3.0,  output: 15.0 },
  'claude-3-haiku':    { input: 0.25, output: 1.25 },

  default: { input: 3.0, output: 15.0 },
};

// ─────────────────────────────────────────────
// VALIDATION
// ─────────────────────────────────────────────

function validatePricing() {
  for (const [model, rates] of Object.entries(MODEL_PRICING)) {
    if (
      typeof rates.input !== 'number' ||
      typeof rates.output !== 'number' ||
      rates.input < 0 ||
      rates.output < 0
    ) {
      throw new Error(`[pricing] Invalid rates for ${model}`);
    }
  }
}

validatePricing();

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function getModelPricing(model) {
  return MODEL_PRICING[model] || MODEL_PRICING.default;
}

/**
 * Calculate cost (USD)
 */
function calculateCostUSD(model, inputTokens = 0, outputTokens = 0) {
  const rates = getModelPricing(model);

  const inputCost  = (inputTokens  / 1_000_000) * rates.input;
  const outputCost = (outputTokens / 1_000_000) * rates.output;

  return Number((inputCost + outputCost).toFixed(8));
}

// ─────────────────────────────────────────────
// MARGIN THRESHOLDS (FIXED)
// ─────────────────────────────────────────────

const MARGIN_THRESHOLDS = {
  HEALTHY_PERCENT:  60,
  WARNING_PERCENT:  40,
  CRITICAL_PERCENT: 20, // ✅ fixed
};

// ─────────────────────────────────────────────
// FREE BURN
// ─────────────────────────────────────────────

const FREE_BURN_THRESHOLDS = {
  WARNING_PERCENT:  40,
  CRITICAL_PERCENT: 60,
};

// ─────────────────────────────────────────────
// FX CONFIG (DYNAMIC READY)
// ─────────────────────────────────────────────

const INR_TO_USD =
  parseFloat(process.env.INR_TO_USD || '0.012');

const PLAN_REVENUE_USD = {
  499: Number((499 * INR_TO_USD).toFixed(2)),
  699: Number((699 * INR_TO_USD).toFixed(2)),
  999: Number((999 * INR_TO_USD).toFixed(2)),
};

// ─────────────────────────────────────────────
// IMMUTABILITY
// ─────────────────────────────────────────────

Object.freeze(MODEL_PRICING);

// ─────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────

module.exports = {
  UNIT,
  MODEL_PRICING,
  getModelPricing,
  calculateCostUSD,
  MARGIN_THRESHOLDS,
  FREE_BURN_THRESHOLDS,
  PLAN_REVENUE_USD,
};