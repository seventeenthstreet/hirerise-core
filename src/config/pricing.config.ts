/**
 * pricing.config.ts
 *
 * Central pricing truth for all Claude models.
 * Rates are USD per 1,000,000 tokens (per-million).
 *
 * UPDATING RATES:
 *   Only edit here. All cost calculations consume this map.
 *   Cost formula: (tokens / 1_000_000) * rate
 *
 * SOURCE: https://www.anthropic.com/pricing (check monthly for updates)
 * Last verified: 2025-Q1
 */

import { ModelPricingMap } from '../types/metrics.types';

export const MODEL_PRICING: ModelPricingMap = {
  // Claude 3.5 family
  'claude-3-5-sonnet-20241022': { input: 3.00,  output: 15.00  },
  'claude-3-5-haiku-20241022':  { input: 0.80,  output: 4.00   },
  'claude-3-5-sonnet-20240620': { input: 3.00,  output: 15.00  },

  // Claude 3 family
  'claude-3-opus-20240229':     { input: 15.00, output: 75.00  },
  'claude-3-sonnet-20240229':   { input: 3.00,  output: 15.00  },
  'claude-3-haiku-20240307':    { input: 0.25,  output: 1.25   },

  // Short aliases used in cost-tracker.service.js observability config
  'claude-3-5-sonnet':          { input: 3.00,  output: 15.00  },
  'claude-3-haiku':             { input: 0.25,  output: 1.25   },

  // Fallback — prevents NaN on unknown models
  'default':                    { input: 3.00,  output: 15.00  },
};

/**
 * calculateCostUSD
 *
 * Computes USD cost for a single AI call using per-million token rates.
 *
 * @param model         - Model string as returned by Anthropic API
 * @param inputTokens   - Prompt tokens consumed
 * @param outputTokens  - Completion tokens generated
 * @returns             - Cost in USD, rounded to 8 decimal places
 */
export function calculateCostUSD(
  model:        string,
  inputTokens:  number,
  outputTokens: number,
): number {
  const rates = MODEL_PRICING[model] ?? MODEL_PRICING['default'];
  const inputCost  = (inputTokens  / 1_000_000) * rates.input;
  const outputCost = (outputTokens / 1_000_000) * rates.output;
  return parseFloat((inputCost + outputCost).toFixed(8));
}

// ─── Health thresholds ────────────────────────────────────────────────────────

export const MARGIN_THRESHOLDS = {
  HEALTHY_PERCENT:  60,   // >= 60% margin = healthy
  WARNING_PERCENT:  40,   // 40–60% = warning
  CRITICAL_PERCENT: 40,   // < 40% = critical
};

export const FREE_BURN_THRESHOLDS = {
  WARNING_PERCENT: 40,    // free tier > 40% of total cost = alert
  CRITICAL_PERCENT: 60,
};

// ─── Revenue mapping (INR plan amounts → USD) ─────────────────────────────────
// Approximate: ₹1 ≈ $0.012 USD (update quarterly)
const INR_TO_USD = 0.012;

export const PLAN_REVENUE_USD: Record<number, number> = {
  499: parseFloat((499 * INR_TO_USD).toFixed(2)),   // ~$5.99
  699: parseFloat((699 * INR_TO_USD).toFixed(2)),   // ~$8.39
  999: parseFloat((999 * INR_TO_USD).toFixed(2)),   // ~$11.99
};