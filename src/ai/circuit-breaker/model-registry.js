'use strict';

/**
 * model-registry.js
 *
 * Central registry for all AI models used in HireRise.
 * Defines primary and fallback chains per feature.
 * Circuit breaker consults this registry for fallback order.
 *
 * FALLBACK STRATEGY:
 *   Fallbacks are ordered by cost-performance tradeoff:
 *   1. A similarly-capable but cheaper model
 *   2. A faster but less capable model (maintain availability over quality)
 *   3. A cached/static response if all AI models unavailable (defined per-feature)
 *
 * EXTENDING:
 *   Add new models by adding entries to MODEL_CATALOG.
 *   Update feature fallback chains as new models are deployed.
 *   Model version is stored with each log — this registry is the source of truth
 *   for which version was active at a given time.
 */

const MODEL_CATALOG = {
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
  'gpt-4-turbo': {
    provider: 'openai',
    contextWindow: 128000,
    tier: 'flagship',
    inputCostPer1k: 0.010,
    outputCostPer1k: 0.030,
  },
  'claude-3-5-sonnet': {
    provider: 'anthropic',
    contextWindow: 200000,
    tier: 'flagship',
    inputCostPer1k: 0.003,
    outputCostPer1k: 0.015,
  },
  'claude-3-haiku': {
    provider: 'anthropic',
    contextWindow: 200000,
    tier: 'efficient',
    inputCostPer1k: 0.00025,
    outputCostPer1k: 0.00125,
  },
};

// Per-feature model configuration
// primary: model used in normal CLOSED circuit state
// fallbacks: ordered list tried on circuit OPEN; first success wins
const FEATURE_MODEL_CONFIG = {
  resume_scoring: {
    primary: 'gpt-4o',
    fallbacks: ['claude-3-5-sonnet', 'gpt-4o-mini'],
  },
  salary_benchmark: {
    primary: 'gpt-4o',
    fallbacks: ['claude-3-5-sonnet', 'gpt-4o-mini'],
  },
  skill_recommendation: {
    primary: 'gpt-4o-mini',
    fallbacks: ['claude-3-haiku'],
  },
  career_path: {
    primary: 'gpt-4o',
    fallbacks: ['claude-3-5-sonnet', 'gpt-4o-mini'],
  },
};

class ModelRegistry {
  getPrimary(feature) {
    return FEATURE_MODEL_CONFIG[feature]?.primary || 'gpt-4o';
  }

  getFallbacks(feature) {
    return FEATURE_MODEL_CONFIG[feature]?.fallbacks || ['gpt-4o-mini'];
  }

  getModelInfo(modelId) {
    return MODEL_CATALOG[modelId] || null;
  }

  getAllFeatureConfigs() {
    return FEATURE_MODEL_CONFIG;
  }
}

module.exports = new ModelRegistry();
module.exports.MODEL_CATALOG = MODEL_CATALOG;
module.exports.FEATURE_MODEL_CONFIG = FEATURE_MODEL_CONFIG;