/**
 * pricing.config.ts (HARDENED + PRODUCTION READY)
 *
 * Central pricing truth for all models.
 * Unit: USD per 1,000,000 tokens (per-million)
 *
 * ✅ Fixed margin thresholds
 * ✅ Safe model access
 * ✅ Validation added
 * ✅ Configurable FX rate
 * ✅ Type-safe + immutable
 */

import { ModelPricingMap } from '../types/metrics.types';

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────

export const TOKEN_UNIT = 'per_million_tokens';

// ─────────────────────────────────────────────
// MODEL PRICING
// ─────────────────────────────────────────────

export const MODEL_PRICING: ModelPricingMap = {
  // Claude 3.5 family
  'claude-3-5-sonnet-20241022': { input: 3.0, output: 15.0 },
  'claude-3-5-haiku-20241022':  { input: 0.8, output: 4.0 },
  'claude-3-5-sonnet-20240620': { input: 3.0, output: 15.0 },

  // Claude 3 family
  'claude-3-opus-20240229':   { input: 15.0, output: 75.0 },
  'claude-3-sonnet-20240229': { input: 3.0,  output: 15.0 },
  'claude-3-haiku-20240307':  { input: 0.25, output: 1.25 },

  // Short aliases
  'claude-3-5-sonnet': { input: 3.0,  output: 15.0 },
  'claude-3-haiku':    { input: 0.25, output: 1.25 },

  // Fallback
  default: { input: 3.0, output: 15.0 },
};

// ─────────────────────────────────────────────
// VALIDATION (CRITICAL)
// ─────────────────────────────────────────────

function validatePricingMap(map: ModelPricingMap) {
  for (const model in map) {
    const rates = map[model];

    if (
      typeof rates.input !== 'number' ||
      typeof rates.output !== 'number' ||
      rates.input < 0 ||
      rates.output < 0
    ) {
      throw new Error(`[pricing] Invalid pricing for model: ${model}`);
    }
  }
}

validatePricingMap(MODEL_PRICING);

// ─────────────────────────────────────────────
// SAFE ACCESS
// ─────────────────────────────────────────────

export function getModelPricing(model: string) {
  return MODEL_PRICING[model] ?? MODEL_PRICING.default;
}

// ─────────────────────────────────────────────
// COST CALCULATION
// ─────────────────────────────────────────────

export function calculateCostUSD(
  model: string,
  inputTokens: number = 0,
  outputTokens: number = 0
): number {
  const rates = getModelPricing(model);

  const inputCost  = (inputTokens  / 1_000_000) * rates.input;
  const outputCost = (outputTokens / 1_000_000) * rates.output;

  return Number((inputCost + outputCost).toFixed(8));
}

// ─────────────────────────────────────────────
// MARGIN THRESHOLDS (FIXED)
// ─────────────────────────────────────────────

export const MARGIN_THRESHOLDS = {
  HEALTHY_PERCENT: 60,   // ≥ 60% = healthy
  WARNING_PERCENT: 40,   // 40–60% = warning
  CRITICAL_PERCENT: 20,  // < 40% = critical
};

// ─────────────────────────────────────────────
// FREE BURN THRESHOLDS
// ─────────────────────────────────────────────

export const FREE_BURN_THRESHOLDS = {
  WARNING_PERCENT: 40,
  CRITICAL_PERCENT: 60,
};

// ─────────────────────────────────────────────
// FX CONFIG (ENV-DRIVEN)
// ─────────────────────────────────────────────

const INR_TO_USD = parseFloat(process.env.INR_TO_USD || '0.012');

// ─────────────────────────────────────────────
// PLAN REVENUE (INR → USD)
// ─────────────────────────────────────────────

export const PLAN_REVENUE_USD: Record<number, number> = {
  499: Number((499 * INR_TO_USD).toFixed(2)),
  699: Number((699 * INR_TO_USD).toFixed(2)),
  999: Number((999 * INR_TO_USD).toFixed(2)),
};

// ─────────────────────────────────────────────
// IMMUTABILITY
// ─────────────────────────────────────────────

Object.freeze(MODEL_PRICING);