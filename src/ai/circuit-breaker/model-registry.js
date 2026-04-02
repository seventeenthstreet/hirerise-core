'use strict';

/**
 * model-registry.js (OPTIMIZED)
 *
 * ✅ Firebase-free
 * ✅ ESM compatible
 * ✅ Validation added
 * ✅ Observability integrated
 * ✅ Supabase-ready (dynamic override ready)
 */

import observability from '../observability/observability-adapter.js';

// ─────────────────────────────────────────────
// MODEL CATALOG
// ─────────────────────────────────────────────

const MODEL_CATALOG = {
  'claude-opus-4-6': {
    provider: 'anthropic',
    contextWindow: 200000,
    tier: 'flagship',
    inputCostPer1k: 0.015,
    outputCostPer1k: 0.075,
  },
  'claude-sonnet-4-6': {
    provider: 'anthropic',
    contextWindow: 200000,
    tier: 'balanced',
    inputCostPer1k: 0.003,
    outputCostPer1k: 0.015,
  },
  'claude-haiku-4-5-20251001': {
    provider: 'anthropic',
    contextWindow: 200000,
    tier: 'efficient',
    inputCostPer1k: 0.00025,
    outputCostPer1k: 0.00125,
  },
  'gpt-4o': {
    provider: 'openai',
    contextWindow: 128000,
    tier: 'flagship',
    inputCostPer1k: 0.005,
    outputCostPer1k: 0.015,
  },
  'gpt-4o-mini': {
    provider: 'openai',
    contextWindow: 128000,
    tier: 'efficient',
    inputCostPer1k: 0.00015,
    outputCostPer1k: 0.0006,
  },
};

// ─────────────────────────────────────────────
// FEATURE CONFIG
// ─────────────────────────────────────────────

const FEATURE_MODEL_CONFIG = {
  resume_scoring: {
    primary: 'claude-sonnet-4-6',
    fallbacks: ['claude-haiku-4-5-20251001'],
  },
  salary_benchmark: {
    primary: 'claude-sonnet-4-6',
    fallbacks: ['claude-haiku-4-5-20251001'],
  },
  skill_recommendation: {
    primary: 'claude-haiku-4-5-20251001',
    fallbacks: [],
  },
  career_path: {
    primary: 'claude-sonnet-4-6',
    fallbacks: ['claude-haiku-4-5-20251001'],
  },
  chi_calculation: {
    primary: 'claude-opus-4-6',
    fallbacks: ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
  },
};

// ─────────────────────────────────────────────
// TIER ROUTING
// ─────────────────────────────────────────────

const TIER_MODEL_ROUTING = {
  free: { default: 'claude-haiku-4-5-20251001' },
  pro: { default: 'claude-sonnet-4-6' },
  elite: { default: 'claude-opus-4-6' },
  enterprise: { default: 'claude-opus-4-6' },
};

// ─────────────────────────────────────────────
// REGISTRY
// ─────────────────────────────────────────────

class ModelRegistry {

  resolveModelForTier(feature, userTier) {
    const tier = this._normalizeTier(userTier);

    // Validate feature
    if (!FEATURE_MODEL_CONFIG[feature]) {
      console.warn(`[ModelRegistry] Unknown feature: ${feature}`);
    }

    let model =
      TIER_MODEL_ROUTING[tier]?.[feature] ||
      TIER_MODEL_ROUTING[tier]?.default ||
      FEATURE_MODEL_CONFIG[feature]?.primary ||
      'claude-sonnet-4-6';

    // Validate model exists
    if (!MODEL_CATALOG[model]) {
      console.error(`[ModelRegistry] Invalid model: ${model}, falling back`);
      model = 'claude-sonnet-4-6';
    }

    // 📊 Observability hook
    observability.emitMetric('model.selection', 1, {
      feature,
      tier,
      model,
    }, 'counter');

    return model;
  }

  getPrimary(feature) {
    return FEATURE_MODEL_CONFIG[feature]?.primary ?? 'claude-sonnet-4-6';
  }

  getFallbacks(feature) {
    return FEATURE_MODEL_CONFIG[feature]?.fallbacks ?? [];
  }

  getModelInfo(modelId) {
    return MODEL_CATALOG[modelId] || null;
  }

  estimateCost(modelId, inputTokens, outputTokens) {
    const rates = MODEL_CATALOG[modelId];
    if (!rates) return 0;

    return +(
      (inputTokens / 1000) * rates.inputCostPer1k +
      (outputTokens / 1000) * rates.outputCostPer1k
    ).toFixed(6);
  }

  // ─────────────────────────────────────────────

  _normalizeTier(tier) {
    if (!tier) return 'free';

    const t = String(tier).toLowerCase().trim();

    if (t === 'premium') return 'pro';
    if (t === 'basic') return 'free';

    return TIER_MODEL_ROUTING[t] ? t : 'free';
  }
}

// Singleton
const registry = new ModelRegistry();

export default registry;
export {
  MODEL_CATALOG,
  FEATURE_MODEL_CONFIG,
  TIER_MODEL_ROUTING,
};