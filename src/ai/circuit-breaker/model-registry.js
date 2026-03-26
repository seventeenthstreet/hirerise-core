'use strict';

/**
 * model-registry.js — PHASE 3 UPDATE
 *
 * CHANGES FROM PHASE 1:
 *
 *   1. MODEL_CATALOG updated with Claude 4 family (Opus 4.6, Sonnet 4.6, Haiku 4.5)
 *      and costs aligned with observability.config.js.
 *
 *   2. TIER_MODEL_ROUTING added — maps user tier × feature → model override.
 *      This is the single source of truth for cost-aware model selection.
 *
 *      free  → Haiku (fastest, cheapest — acceptable quality for quick operations)
 *      pro   → Sonnet (balanced quality/cost)
 *      elite → Opus  (maximum quality — paid tier, worth the cost)
 *
 *   3. resolveModelForTier(feature, userTier) — new exported function.
 *      Call this in route handlers or engines instead of using MODEL env var directly.
 *      Falls back to feature primary if no tier override is defined.
 *
 *   4. chi_calculation feature config updated with correct model IDs.
 *
 * BACKWARD COMPATIBLE:
 *   getPrimary() and getFallbacks() are unchanged — circuit breaker still works.
 *
 * USAGE:
 *   const { resolveModelForTier } = require('../../ai/circuit-breaker/model-registry');
 *   const model = resolveModelForTier('fullAnalysis', req.user.normalizedTier);
 *   // → 'claude-haiku-4-5-20251001' for free, 'claude-sonnet-4-6' for pro, etc.
 *
 * @module ai/circuit-breaker/model-registry
 */

// ─── Model catalog ────────────────────────────────────────────────────────────
// Single source of truth for model capabilities and costs.
// Costs are per 1000 tokens (matching observability.config.js scale).

const MODEL_CATALOG = {
  // ── Claude 4 family (production) ─────────────────────────────────────────
  'claude-opus-4-6': {
    provider:      'anthropic',
    contextWindow: 200000,
    tier:          'flagship',
    inputCostPer1k:  0.015,
    outputCostPer1k: 0.075,
  },
  'claude-sonnet-4-6': {
    provider:      'anthropic',
    contextWindow: 200000,
    tier:          'balanced',
    inputCostPer1k:  0.003,
    outputCostPer1k: 0.015,
  },
  'claude-haiku-4-5-20251001': {
    provider:      'anthropic',
    contextWindow: 200000,
    tier:          'efficient',
    inputCostPer1k:  0.00025,
    outputCostPer1k: 0.00125,
  },
  // ── Legacy model IDs (kept for circuit breaker history / fallback chains) ─
  'claude-sonnet-4-20250514': {
    provider:      'anthropic',
    contextWindow: 200000,
    tier:          'balanced',
    inputCostPer1k:  0.003,
    outputCostPer1k: 0.015,
  },
  // ── OpenAI (retained for shadow model comparison) ─────────────────────────
  'gpt-4o': {
    provider:      'openai',
    contextWindow: 128000,
    tier:          'flagship',
    inputCostPer1k:  0.005,
    outputCostPer1k: 0.015,
  },
  'gpt-4o-mini': {
    provider:      'openai',
    contextWindow: 128000,
    tier:          'efficient',
    inputCostPer1k:  0.00015,
    outputCostPer1k: 0.0006,
  },
};

// ─── Per-feature model configuration (circuit breaker fallback chains) ────────
// primary:   model used in normal CLOSED circuit state (when no tier override applies)
// fallbacks: ordered list tried on circuit OPEN; first success wins

const FEATURE_MODEL_CONFIG = {
  resume_scoring: {
    primary:   'claude-sonnet-4-6',
    fallbacks: ['claude-haiku-4-5-20251001'],
  },
  salary_benchmark: {
    primary:   'claude-sonnet-4-6',
    fallbacks: ['claude-haiku-4-5-20251001'],
  },
  skill_recommendation: {
    primary:   'claude-haiku-4-5-20251001',
    fallbacks: [],
  },
  career_path: {
    primary:   'claude-sonnet-4-6',
    fallbacks: ['claude-haiku-4-5-20251001'],
  },
  // Phase 1 addition — CHI calculation
  chi_calculation: {
    primary:   'claude-opus-4-6',
    fallbacks: ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
  },
};

// ─── Tier × feature model routing ─────────────────────────────────────────────
//
// PHASE 3: Cost-aware model selection by user tier.
//
// Priority order when selecting a model:
//   1. TIER_MODEL_ROUTING[userTier][feature]  — most specific
//   2. TIER_MODEL_ROUTING[userTier].default   — tier default
//   3. FEATURE_MODEL_CONFIG[feature].primary  — feature default (fallback)
//   4. 'claude-sonnet-4-6'                    — hard fallback
//
// To change the model for a tier/feature: update this table only.
// No engine code changes needed.

const TIER_MODEL_ROUTING = {
  free: {
    default:          'claude-haiku-4-5-20251001',
    fullAnalysis:     'claude-haiku-4-5-20251001',
    generateCV:       'claude-haiku-4-5-20251001',
    jobMatchAnalysis: 'claude-haiku-4-5-20251001',
    jobSpecificCV:    'claude-haiku-4-5-20251001',
    chi_calculation:  'claude-haiku-4-5-20251001',
  },
  pro: {
    default:          'claude-sonnet-4-6',
    fullAnalysis:     'claude-sonnet-4-6',
    generateCV:       'claude-sonnet-4-6',
    jobMatchAnalysis: 'claude-sonnet-4-6',
    jobSpecificCV:    'claude-sonnet-4-6',
    chi_calculation:  'claude-sonnet-4-6',
  },
  elite: {
    default:          'claude-opus-4-6',
    fullAnalysis:     'claude-opus-4-6',
    generateCV:       'claude-sonnet-4-6',  // CV generation doesn't need Opus
    jobMatchAnalysis: 'claude-sonnet-4-6',  // JD match is analytical, Sonnet sufficient
    jobSpecificCV:    'claude-opus-4-6',    // Job-specific CV tailoring benefits from Opus
    chi_calculation:  'claude-opus-4-6',
  },
  enterprise: {
    // Enterprise inherits elite routing — override per-account in future
    default:          'claude-opus-4-6',
    fullAnalysis:     'claude-opus-4-6',
    generateCV:       'claude-sonnet-4-6',
    jobMatchAnalysis: 'claude-sonnet-4-6',
    jobSpecificCV:    'claude-opus-4-6',
    chi_calculation:  'claude-opus-4-6',
  },
};

// ─── ModelRegistry class ──────────────────────────────────────────────────────

class ModelRegistry {
  /**
   * resolveModelForTier(feature, userTier)
   *
   * PHASE 3: Primary model selection method for all AI call sites.
   * Returns the correct model for this user's tier and the requested feature.
   *
   * @param {string} feature   — e.g. 'fullAnalysis', 'chi_calculation'
   * @param {string} userTier  — 'free' | 'pro' | 'elite' | 'enterprise'
   * @returns {string}         — model identifier
   */
  resolveModelForTier(feature, userTier) {
    const normalizedTier = this._normalizeTier(userTier);
    const tierConfig = TIER_MODEL_ROUTING[normalizedTier];

    if (tierConfig) {
      // Feature-specific override wins over tier default
      if (tierConfig[feature]) return tierConfig[feature];
      if (tierConfig.default)  return tierConfig.default;
    }

    // Fall through to feature primary (circuit breaker baseline)
    return FEATURE_MODEL_CONFIG[feature]?.primary ?? 'claude-sonnet-4-6';
  }

  /**
   * getPrimary(feature)
   * Unchanged from Phase 1 — used by circuit breaker for fallback chain.
   */
  getPrimary(feature) {
    return FEATURE_MODEL_CONFIG[feature]?.primary ?? 'claude-sonnet-4-6';
  }

  /**
   * getFallbacks(feature)
   * Unchanged from Phase 1.
   */
  getFallbacks(feature) {
    return FEATURE_MODEL_CONFIG[feature]?.fallbacks ?? [];
  }

  getModelInfo(modelId) {
    return MODEL_CATALOG[modelId] || null;
  }

  getAllFeatureConfigs() {
    return FEATURE_MODEL_CONFIG;
  }

  getTierRouting() {
    return TIER_MODEL_ROUTING;
  }

  /**
   * estimateCost(modelId, inputTokens, outputTokens)
   *
   * Quick cost estimate for a call. Returns USD.
   * Used by cost monitoring middleware.
   *
   * @param {string} modelId
   * @param {number} inputTokens
   * @param {number} outputTokens
   * @returns {number} cost in USD
   */
  estimateCost(modelId, inputTokens, outputTokens) {
    const rates = MODEL_CATALOG[modelId];
    if (!rates) return 0;
    return +((inputTokens / 1000) * rates.inputCostPer1k +
             (outputTokens / 1000) * rates.outputCostPer1k).toFixed(6);
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  _normalizeTier(tier) {
    if (!tier) return 'free';
    const t = String(tier).toLowerCase().trim();
    // Accept common aliases
    if (t === 'premium') return 'pro';
    if (t === 'basic')   return 'free';
    return TIER_MODEL_ROUTING[t] ? t : 'free';
  }
}

const registry = new ModelRegistry();
module.exports = registry;
module.exports.MODEL_CATALOG        = MODEL_CATALOG;
module.exports.FEATURE_MODEL_CONFIG = FEATURE_MODEL_CONFIG;
module.exports.TIER_MODEL_ROUTING   = TIER_MODEL_ROUTING;








