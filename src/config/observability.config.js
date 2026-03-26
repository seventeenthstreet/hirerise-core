'use strict';

/**
 * Centralized observability configuration for HireRise AI systems.
 * Modify thresholds here without touching service logic.
 */

const OBSERVABILITY_CONFIG = {
  // === MODEL COST RATES (USD per 1K tokens) ===
  modelRates: {
    // ── Claude 4 family (models currently in production) ─────────────────────
    // NOTE: rates are per 1000 tokens (not per million — this map uses a different
    // scale than pricing.config.js which uses per-million).
    // TODO: Confirm final rates against https://www.anthropic.com/pricing
    'claude-opus-4-6':           { input: 0.015,   output: 0.075   },  // TODO: confirm
    'claude-sonnet-4-20250514':  { input: 0.003,   output: 0.015   },  // TODO: confirm
    // ── Legacy models ─────────────────────────────────────────────────────────
    'gpt-4o': { input: 0.005, output: 0.015 },
    'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
    'gpt-4-turbo': { input: 0.01, output: 0.03 },
    'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 },
    'claude-3-5-sonnet': { input: 0.003, output: 0.015 },
    'claude-3-haiku': { input: 0.00025, output: 0.00125 },
    default: { input: 0.005, output: 0.015 },
  },

  // === LATENCY THRESHOLDS (ms) ===
  latency: {
    p95WarningMs: 3000,
    p95CriticalMs: 6000,
    singleCallWarningMs: 5000,
  },

  // === ERROR RATE THRESHOLDS (ratio, 0–1) ===
  errorRate: {
    warningThreshold: 0.05,  // 5%
    criticalThreshold: 0.15, // 15%
    windowMinutes: 60,
  },

  // === DRIFT DETECTION ===
  drift: {
    baselineWindowDays: 30,
    minSamplesForBaseline: 50,
    scoreDeviationThreshold: 0.15,   // 15% deviation triggers alert
    salaryDeviationThreshold: 0.10,  // 10% deviation triggers alert
    confidenceDeviationThreshold: 0.12,
    features: ['resume_scoring', 'salary_benchmark', 'skill_recommendation', 'career_path'],
  },

  // === TOKEN SPIKE DETECTION ===
  tokens: {
    avgMultiplierForSpike: 3.0, // 3x rolling average = spike
    absoluteSpikeThreshold: 10000, // single call tokens
  },

  // === BUDGET THRESHOLDS (USD) ===
  budget: {
    monthlyWarningUSD: 500,
    monthlyCriticalUSD: 1000,
    perUserMonthlyWarningUSD: 5,
    perFeatureMonthlyWarningUSD: 200,
  },

  // === LOG RETENTION (days) ===
  retention: {
    aiLogsRetentionDays: 90,
    metricsRetentionDays: 365,
    driftRetentionDays: 180,
    costRetentionDays: 730, // 2 years for compliance
    alertsRetentionDays: 180,
  },

  // === AGGREGATION ===
  aggregation: {
    dailyWorkerCronUTC: '0 1 * * *', // 1am UTC daily
    batchWriteSize: 500,
  },
};

module.exports = OBSERVABILITY_CONFIG;








