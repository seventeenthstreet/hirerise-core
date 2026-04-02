'use strict';

const circuitBreaker = require('../ai/circuit-breaker/circuit-breaker.service');
const modelRegistry  = require('../ai/circuit-breaker/model-registry');
const logger         = require('../utils/logger');

const { withAiConcurrency } = require('../core/aiConcurrency');

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────

const EXECUTION_TIMEOUT_MS = parseInt(
  process.env.AI_EXECUTION_TIMEOUT_MS || '15000',
  10
);

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function validateFeature(feature) {
  const available = Object.values(module.exports.FEATURES);

  if (!available.includes(feature)) {
    throw new Error(`Invalid feature: ${feature}`);
  }
}

async function withTimeout(fn) {
  return Promise.race([
    fn(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('AI_TIMEOUT')), EXECUTION_TIMEOUT_MS)
    ),
  ]);
}

// ─────────────────────────────────────────────
// Main Execution
// ─────────────────────────────────────────────

async function execute(feature, fn, { userId = 'system' } = {}) {
  validateFeature(feature);

  const primary   = modelRegistry.getPrimary(feature);
  const fallbacks = modelRegistry.getFallbacks(feature);

  const start = Date.now();

  try {
    const result = await withAiConcurrency(feature, userId, async () => {
      return await circuitBreaker.execute(feature, primary, fallbacks, async (model) => {
        const modelStart = Date.now();

        try {
          const res = await withTimeout(() => fn(model));

          logger.debug('[CircuitBreakerRegistry] Model success', {
            feature,
            model,
            latencyMs: Date.now() - modelStart,
          });

          return res;

        } catch (err) {
          logger.warn('[CircuitBreakerRegistry] Model failed', {
            feature,
            model,
            latencyMs: Date.now() - modelStart,
            error: err.message,
          });

          throw err;
        }
      });
    });

    logger.info('[CircuitBreakerRegistry] Execution success', {
      feature,
      totalLatencyMs: Date.now() - start,
    });

    return result;

  } catch (err) {
    logger.error('[CircuitBreakerRegistry] All models exhausted', {
      feature,
      primary,
      fallbacks,
      totalLatencyMs: Date.now() - start,
      error: err.message,
    });

    throw err;
  }
}

// ─────────────────────────────────────────────
// Status APIs
// ─────────────────────────────────────────────

function getStatus(feature) {
  return circuitBreaker.getCircuitStatus(feature);
}

function getAllStatuses() {
  return circuitBreaker.getAllStatuses();
}

async function tripManually(feature, currentModel, fallbackModel) {
  logger.warn('[CircuitBreakerRegistry] Manual trip', {
    feature,
    currentModel,
    fallbackModel,
  });

  await circuitBreaker.tripFromDrift(feature, currentModel, fallbackModel);
}

// ─────────────────────────────────────────────
// Feature Constants
// ─────────────────────────────────────────────

const FEATURES = Object.freeze({
  RESUME_SCORING:       'resume_scoring',
  SALARY_BENCHMARK:     'salary_benchmark',
  SKILL_RECOMMENDATION: 'skill_recommendation',
  CAREER_PATH:          'career_path',
  CHI_CALCULATION:      'chi_calculation',
});

// ─────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────

module.exports = {
  execute,
  getStatus,
  getAllStatuses,
  tripManually,
  FEATURES,
};