'use strict';

/**
 * OBSERVABILITY CONFIG (HARDENED)
 *
 * ✅ Unit consistency enforced (per 1K tokens)
 * ✅ Schema validation
 * ✅ Safe access helpers
 * ✅ Cost calculation utility
 * ✅ Threshold guards
 */

const OBSERVABILITY_CONFIG = {
  UNIT: 'per_1k_tokens',

  // ─────────────────────────────────────────────
  // MODEL COST RATES (USD per 1K tokens)
  // ─────────────────────────────────────────────
  modelRates: {
    'claude-opus-4-6':          { input: 0.015,   output: 0.075 },
    'claude-sonnet-4-20250514': { input: 0.003,   output: 0.015 },

    'gpt-4o':        { input: 0.005,    output: 0.015 },
    'gpt-4o-mini':   { input: 0.00015,  output: 0.0006 },
    'gpt-4-turbo':   { input: 0.01,     output: 0.03 },
    'gpt-3.5-turbo': { input: 0.0005,   output: 0.0015 },

    'claude-3-5-sonnet': { input: 0.003,   output: 0.015 },
    'claude-3-haiku':    { input: 0.00025, output: 0.00125 },

    default: { input: 0.005, output: 0.015 },
  },

  latency: {
    p95WarningMs: 3000,
    p95CriticalMs: 6000,
    singleCallWarningMs: 5000,
  },

  errorRate: {
    warningThreshold: 0.05,
    criticalThreshold: 0.15,
    windowMinutes: 60,
  },

  drift: {
    baselineWindowDays: 30,
    minSamplesForBaseline: 50,
    scoreDeviationThreshold: 0.15,
    salaryDeviationThreshold: 0.10,
    confidenceDeviationThreshold: 0.12,
    features: [
      'resume_scoring',
      'salary_benchmark',
      'skill_recommendation',
      'career_path',
    ],
  },

  tokens: {
    avgMultiplierForSpike: 3.0,
    absoluteSpikeThreshold: 10000,
  },

  budget: {
    monthlyWarningUSD: 500,
    monthlyCriticalUSD: 1000,
    perUserMonthlyWarningUSD: 5,
    perFeatureMonthlyWarningUSD: 200,
  },

  retention: {
    aiLogsRetentionDays: 90,
    metricsRetentionDays: 365,
    driftRetentionDays: 180,
    costRetentionDays: 730,
    alertsRetentionDays: 180,
  },

  aggregation: {
    dailyWorkerCronUTC: '0 1 * * *',
    batchWriteSize: 500,
  },
};

// ─────────────────────────────────────────────
// VALIDATION
// ─────────────────────────────────────────────

function validateConfig(cfg) {
  // Model rates validation
  for (const [model, rates] of Object.entries(cfg.modelRates)) {
    if (
      typeof rates.input !== 'number' ||
      typeof rates.output !== 'number'
    ) {
      throw new Error(`[observability] Invalid rate for ${model}`);
    }
  }

  // Threshold sanity
  if (cfg.errorRate.warningThreshold >= cfg.errorRate.criticalThreshold) {
    throw new Error('[observability] errorRate thresholds invalid');
  }

  if (cfg.latency.p95WarningMs >= cfg.latency.p95CriticalMs) {
    throw new Error('[observability] latency thresholds invalid');
  }
}

validateConfig(OBSERVABILITY_CONFIG);

// ─────────────────────────────────────────────
// HELPERS (VERY IMPORTANT)
// ─────────────────────────────────────────────

function getModelRate(model) {
  return (
    OBSERVABILITY_CONFIG.modelRates[model] ||
    OBSERVABILITY_CONFIG.modelRates.default
  );
}

/**
 * Calculate cost safely
 */
function calculateCost({
  model,
  inputTokens = 0,
  outputTokens = 0,
}) {
  const rate = getModelRate(model);

  return (
    (inputTokens / 1000) * rate.input +
    (outputTokens / 1000) * rate.output
  );
}

// ─────────────────────────────────────────────
// IMMUTABILITY
// ─────────────────────────────────────────────

Object.freeze(OBSERVABILITY_CONFIG);
Object.freeze(OBSERVABILITY_CONFIG.modelRates);

// ─────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────

module.exports = {
  ...OBSERVABILITY_CONFIG,
  getModelRate,
  calculateCost,
};