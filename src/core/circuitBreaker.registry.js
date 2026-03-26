'use strict';

/**
 * circuitBreaker.registry.js — PHASE 1: Circuit Breaker Registry
 *
 * PROBLEM FIXED:
 *   The CircuitBreakerService exists but is only used in select places.
 *   AI calls in careerHealthIndex.service.js, resumeScore.service.js, and others
 *   call the Anthropic client directly without any circuit breaker protection.
 *   An Anthropic outage causes these endpoints to hang for 30s (TCP timeout)
 *   before failing, tying up all server connections.
 *
 * SOLUTION:
 *   A named-instance registry that any module can import to get the circuit
 *   breaker for a specific AI feature. All AI service calls must go through
 *   the registry.
 *
 *   Usage:
 *     const registry = require('./circuitBreaker.registry');
 *     const result = await registry.execute('chi-calculation', async (model) => {
 *       return anthropic.messages.create({ model, ... });
 *     });
 *
 * REGISTRY FEATURES:
 *   - Named circuit per feature (state isolated between features)
 *   - Automatic model selection from MODEL_REGISTRY
 *   - Fallback chain execution on primary failure
 *   - Status API for admin observability endpoint
 *
 * MULTI-REPLICA NOTE:
 *   The CircuitBreakerService stores state in-process (Map). In a multi-replica
 *   deployment, each replica has independent state — a failing primary won't
 *   trip all replicas. Phase 4 will migrate state to Redis for global circuit
 *   coordination. For Phase 1, in-process state is sufficient and correct.
 */

const circuitBreaker = require('../ai/circuit-breaker/circuit-breaker.service');
const modelRegistry  = require('../ai/circuit-breaker/model-registry');
const logger         = require('../utils/logger');

/**
 * Execute an AI function with full circuit breaker protection.
 *
 * @param {string}   feature     — matches MODEL_REGISTRY keys:
 *                                 'resume_scoring' | 'salary_benchmark' |
 *                                 'skill_recommendation' | 'career_path'
 * @param {Function} fn          — async (modelId: string) => result
 *                                 Receives the model to use (may be fallback)
 * @returns {Promise<*>} AI result
 * @throws if all models fail
 */
async function execute(feature, fn) {
  const primary   = modelRegistry.getPrimary(feature);
  const fallbacks = modelRegistry.getFallbacks(feature);

  try {
    return await circuitBreaker.execute(feature, primary, fallbacks, fn);
  } catch (err) {
    logger.error('[CircuitBreakerRegistry] All models exhausted for feature', {
      feature, primary, fallbacks, err: err.message,
    });
    throw err;
  }
}

/**
 * Get the current circuit state for a feature.
 * @param {string} feature
 */
function getStatus(feature) {
  return circuitBreaker.getCircuitStatus(feature);
}

/**
 * Get all circuit statuses (for admin monitoring endpoint).
 */
function getAllStatuses() {
  return circuitBreaker.getAllStatuses();
}

/**
 * Manually trip a circuit (for testing or emergency use).
 * @param {string} feature
 * @param {string} currentModel
 * @param {string} fallbackModel
 */
async function tripManually(feature, currentModel, fallbackModel) {
  logger.warn('[CircuitBreakerRegistry] Manual circuit trip triggered', {
    feature, currentModel, fallbackModel,
  });
  await circuitBreaker.tripFromDrift(feature, currentModel, fallbackModel);
}

module.exports = {
  execute,
  getStatus,
  getAllStatuses,
  tripManually,
  // Feature name constants to avoid typos
  FEATURES: Object.freeze({
    RESUME_SCORING:       'resume_scoring',
    SALARY_BENCHMARK:     'salary_benchmark',
    SKILL_RECOMMENDATION: 'skill_recommendation',
    CAREER_PATH:          'career_path',
    CHI_CALCULATION:      'chi_calculation',  // New feature added here
  }),
};








