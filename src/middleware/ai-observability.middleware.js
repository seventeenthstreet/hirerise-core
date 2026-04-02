'use strict';

/**
 * observability.middleware.js (Production Optimized)
 */

const { supabase } = require('../config/supabase'); // ✅ REQUIRED (do not remove)

// Observability stack
const AILogger = require('../ai/observability/logger');
const logger = require('../utils/logger');

const driftService = require('../ai/observability/drift.service');
const costTracker = require('../ai/observability/cost-tracker.service');
const alertService = require('../ai/observability/alert.service');

const circuitBreaker = require('../ai/circuit-breaker/circuit-breaker.service');
const modelRegistry = require('../ai/circuit-breaker/model-registry');

const shadowModelService = require('../ai/shadow/shadow-model.service');
const observabilityAdapter = require('../ai/observability/observability-adapter');

// ─────────────────────────────────────────────────────────────────────────────
// CORE WRAPPER
// ─────────────────────────────────────────────────────────────────────────────

const withObservability = async (config, fn, options = {}) => {
  const {
    feature,
    userId,
    model: configuredModel,
    modelVersion = null,
    inputHash = null,
    correlationId = null,
    segment = {},
  } = config;

  const {
    shadowFn = null,
    shadowModel = null,
    useCircuitBreaker = true,
  } = options;

  const primaryModel = configuredModel || modelRegistry.getPrimary(feature);
  const fallbackModels = modelRegistry.getFallbacks(feature);

  const span = observabilityAdapter.emitTrace(
    `ai.inference.${feature}`,
    { feature, model: primaryModel, user_id: userId || 'anonymous' },
    correlationId
  );

  const timer = AILogger.startTimer();

  let fnResult = null;
  let actualModel = primaryModel;
  let success = false;
  let aiError = null;
  let modelSwitched = false;

  try {
    // ─── Circuit Breaker Execution ─────────────────────────────
    if (useCircuitBreaker) {
      fnResult = await circuitBreaker.execute(
        feature,
        primaryModel,
        fallbackModels,
        async (modelToUse) => {
          if (modelToUse !== primaryModel) {
            modelSwitched = true; // ✅ FIXED
          }
          actualModel = modelToUse;
          return fn(modelToUse);
        }
      );
    } else {
      actualModel = primaryModel;
      fnResult = await fn(primaryModel);
    }

    success = true;

    // ─── Shadow Execution ─────────────────────────────────────
    if (shadowFn && shadowModel) {
      shadowModelService.runShadowIfSampled(
        {
          feature,
          primaryModel: actualModel,
          shadowModel,
          userId,
          correlationId,
        },
        {
          ...fnResult,
          latencyMs: AILogger.elapsedMs(timer),
        },
        () => shadowFn(shadowModel)
      );
    }

  } catch (err) {
    aiError = {
      code: err.code || 'AI_ERROR',
      message: err.message,
    };

    span.recordException(err);
    span.setStatus('ERROR', err.message);

    throw err;

  } finally {
    const latencyMs = Math.round(AILogger.elapsedMs(timer));

    const {
      tokensInput = 0,
      tokensOutput = 0,
      confidenceScore = null,
      outputSummary = null,
    } = fnResult || {};

    // ─── Span Attributes ──────────────────────────────────────
    span.setAttribute('latency_ms', latencyMs);
    span.setAttribute('success', success);
    span.setAttribute('actual_model', actualModel);
    span.setAttribute('model_switched', modelSwitched);

    if (correlationId) {
      span.setAttribute('correlation_id', correlationId);
    }

    span.end();

    // ─── Metrics Event ────────────────────────────────────────
    observabilityAdapter.emitInferenceEvent({
      feature,
      model: actualModel,
      latencyMs,
      success,
      tokensTotal: tokensInput + tokensOutput,
      confidenceScore,
    });

    // ─── Structured Logging ───────────────────────────────────
    logger.info('[AI Observability]', {
      feature,
      userId,
      model: actualModel,
      modelVersion,
      inputHash,
      outputSummary,
      tokensInput,
      tokensOutput,
      confidenceScore,
      success,
      error: aiError,
      latencyMs,
      correlationId,
      modelSwitched,
    });

    // ─── Cost Tracking (Supabase-backed expected) ─────────────
    let costUSD = 0;
    try {
      costUSD = await costTracker.track({
        userId,
        feature,
        model: actualModel,
        tokensInput,
        tokensOutput,
        supabase, // ✅ pass explicitly if needed downstream
      });
    } catch (err) {
      logger.warn('[AI Observability] Cost tracking failed', {
        userId,
        error: err.message,
      });
    }

    // ─── Alerts (non-blocking) ────────────────────────────────
    alertService
      .checkLatency(feature, latencyMs, actualModel, correlationId)
      .catch(() => {});

    alertService
      .checkTokenSpike(feature, tokensInput + tokensOutput, actualModel, correlationId)
      .catch(() => {});

    // ─── Drift Monitoring ─────────────────────────────────────
    if (success && fnResult) {
      driftService.observe({
        feature,
        userId,
        model: actualModel,
        score: outputSummary?.score,
        salaryMedian: outputSummary?.salaryMedian,
        confidenceScore,
        segment,
        correlationId,
      }).catch(() => {});
    }

    // ─── Attach Observability Metadata ────────────────────────
    if (fnResult) {
      fnResult._observability = {
        costUSD,
        latencyMs,
        model: actualModel,
        correlationId,
      };
    }
  }

  return fnResult;
};

// ─────────────────────────────────────────────────────────────────────────────
// EXPRESS MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────

const observabilityMiddleware = ({ feature } = {}) => {
  return (req, res, next) => {
    res.locals.aiTimer = AILogger.startTimer();
    res.locals.aiFeature =
      feature || req.path.split('/')[1] || 'unknown';

    res.locals.correlationId = req.correlationId;

    next();
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  observabilityMiddleware,
  withObservability,
};