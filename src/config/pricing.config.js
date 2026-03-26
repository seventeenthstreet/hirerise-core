'use strict';

/**
 * pricing.config.js
 * Converted from pricing.config.ts
 */

const MODEL_PRICING = {
  // ── Claude 4 family (models currently in production) ──────────────────────
  // TODO: Verify these rates against https://www.anthropic.com/pricing before
  //       enabling margin monitoring in production. These are placeholder values
  //       based on publicly available Claude 4 pricing as of early 2025.
  //       Update when Anthropic confirms final per-token rates for these models.
  'claude-opus-4-6':           { input: 15.00, output: 75.00 },  // TODO: confirm rate
  'claude-sonnet-4-20250514':  { input: 3.00,  output: 15.00 },  // TODO: confirm rate

  // ── Claude 3.x family (legacy — kept for historical cost log lookups) ─────
  'claude-3-5-sonnet-20241022': { input: 3.00,  output: 15.00 },
  'claude-3-5-haiku-20241022':  { input: 0.80,  output: 4.00  },
  'claude-3-5-sonnet-20240620': { input: 3.00,  output: 15.00 },
  'claude-3-opus-20240229':     { input: 15.00, output: 75.00 },
  'claude-3-sonnet-20240229':   { input: 3.00,  output: 15.00 },
  'claude-3-haiku-20240307':    { input: 0.25,  output: 1.25  },
  'claude-3-5-sonnet':          { input: 3.00,  output: 15.00 },
  'claude-3-haiku':             { input: 0.25,  output: 1.25  },
  'default':                    { input: 3.00,  output: 15.00 },
};

function calculateCostUSD(model, inputTokens, outputTokens) {
  const rates = MODEL_PRICING[model] ?? MODEL_PRICING['default'];
  const inputCost  = (inputTokens  / 1_000_000) * rates.input;
  const outputCost = (outputTokens / 1_000_000) * rates.output;
  return parseFloat((inputCost + outputCost).toFixed(8));
}

const MARGIN_THRESHOLDS = {
  HEALTHY_PERCENT:  60,
  WARNING_PERCENT:  40,
  CRITICAL_PERCENT: 40,
};

const FREE_BURN_THRESHOLDS = {
  WARNING_PERCENT:  40,
  CRITICAL_PERCENT: 60,
};

const INR_TO_USD = 0.012;
const PLAN_REVENUE_USD = {
  499: parseFloat((499 * INR_TO_USD).toFixed(2)),
  699: parseFloat((699 * INR_TO_USD).toFixed(2)),
  999: parseFloat((999 * INR_TO_USD).toFixed(2)),
};

module.exports = { MODEL_PRICING, calculateCostUSD, MARGIN_THRESHOLDS, FREE_BURN_THRESHOLDS, PLAN_REVENUE_USD };








