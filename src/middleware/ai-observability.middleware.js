'use strict';

const AILogger = require('../ai/observability/logger');
const driftService = require('../ai/observability/drift.service');
const costTracker = require('../ai/observability/cost-tracker.service');
const alertService = require('../ai/observability/alert.service');
const circuitBreaker = require('../ai/circuit-breaker/circuit-breaker.service');
const modelRegistry = require('../ai/circuit-breaker/model-registry');
const shadowModelService = require('../ai/shadow/shadow-model.service');
const observabilityAdapter = require('../adapters/observability-adapter');

/**
 * ai-observability.middleware.js (V2)
 *
 * CHANGES FROM V1:
 *   + correlationId threaded through entire call lifecycle
 *   + Circuit breaker integration — automatic model fallback
 *   + Shadow model support — optional silent parallel call
 *   + Segment metadata passed to drift service
 *   + OTel trace span emitted for each inference call
 *   + Updated emitInferenceEvent call for Datadog/Prometheus
 *
 * BACKWARD COMPATIBLE:
 *   Existing callers using V1 withObservability signature work unchanged.
 *   New fields (correlationId, segment, shadowFn) are optional.
 *
 * UPDATED SIGNATURE:
 *   withObservability(config, fn, options?)
 *
 * config:
 *   feature, userId, model, modelVersion, inputHash  (unchanged from V1)
 *   correlationId   - from req.correlationId (injected by correlationMiddleware)
 *   segment         - { role_family, industry, geography, experience_level }
 *
 * options:
 *   shadowFn        - async (model) => { ... } — shadow model call
 *   shadowModel     - model identifier for shadow test
 *   useCircuitBreaker - default true; set false to bypass for internal tooling
 */

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

  // Resolve model from registry
  const primaryModel = configuredModel || modelRegistry.getPrimary(feature);
  const fallbackModels = modelRegistry.getFallbacks(feature);

  // OTel trace span for this inference call
  const span = observabilityAdapter.emitTrace(
    `ai.inference.${feature}`,
    { feature, model: primaryModel, userId: userId || 'anonymous' },
    correlationId
  );

  const timer = AILogger.startTimer();
  let fnResult = null;
  let actualModel = primaryModel;
  let success = false;
  let aiError = null;
  let modelSwitched = false;

  try {
    // ── Execute with circuit breaker (or direct) ──────────────────────────
    if (useCircuitBreaker) {
      fnResult = await circuitBreaker.execute(
        feature,
        primaryModel,
        fallbackModels,
        async (modelToUse) => {
          actualModel = modelToUse;
          return fn(modelToUse);
        }
      );
      modelSwitched = fnResult?._modelSwitched === true;
    } else {
      actualModel = primaryModel;
      fnResult = await fn(primaryModel);
    }

    success = true;

    // ── Shadow model (non-blocking, 5% sample) ────────────────────────────
    if (shadowFn && shadowModel) {
      shadowModelService.runShadowIfSampled(
        { feature, primaryModel: actualModel, shadowModel, userId, correlationId },
        { ...fnResult, latencyMs: AILogger.elapsedMs(timer) },
        () => shadowFn(shadowModel)
      );
    }
  } catch (err) {
    aiError = { code: err.code || 'AI_ERROR', message: err.message };
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

    span.setAttribute('latency_ms', latencyMs);
    span.setAttribute('success', success);
    span.setAttribute('actual_model', actualModel);
    span.setAttribute('model_switched', modelSwitched);
    if (correlationId) span.setAttribute('correlation_id', correlationId);
    span.end();

    // ── Emit to OTel/Prometheus ───────────────────────────────────────────
    observabilityAdapter.emitInferenceEvent({
      feature,
      model: actualModel,
      latencyMs,
      success,
      tokensTotal: tokensInput + tokensOutput,
      confidenceScore,
      correlationId,
    });

    // ── Structured log ────────────────────────────────────────────────────
    AILogger.log({
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
      timer,
      metadata: {
        correlationId,
        modelSwitched,
        circuitBreakerState: circuitBreaker.getCircuitStatus(feature).state,
        ...(segment.role_family ? { segmentRoleFamily: segment.role_family } : {}),
      },
    });

    // ── Cost tracking ─────────────────────────────────────────────────────
    const costUSD = await costTracker.track({
      userId, feature, model: actualModel, tokensInput, tokensOutput,
    }).catch(() => 0);

    // ── Alert checks ──────────────────────────────────────────────────────
    alertService.checkLatency(feature, latencyMs, actualModel, correlationId).catch(() => {});
    alertService.checkTokenSpike(feature, tokensInput + tokensOutput, actualModel, correlationId).catch(() => {});

    // ── Drift observation ─────────────────────────────────────────────────
    if (success && fnResult) {
      driftService.observe({
        feature, userId, model: actualModel,
        score: outputSummary?.score,
        salaryMedian: outputSummary?.salaryMedian,
        confidenceScore,
        segment,
        correlationId,
      }).catch(() => {});
    }

    if (fnResult) {
      fnResult._observability = {
        costUSD,
        latencyMs,
        model: actualModel,
        modelSwitched,
        correlationId,
      };
    }
  }

  return fnResult;
};

/**
 * Express middleware factory (unchanged API from V1).
 */
const observabilityMiddleware = ({ feature } = {}) => {
  return (req, res, next) => {
    res.locals.aiTimer = AILogger.startTimer();
    res.locals.aiFeature = feature || req.path.split('/')[1] || 'unknown';
    res.locals.correlationId = req.correlationId; // set by correlationMiddleware
    next();
  };
};

module.exports = { observabilityMiddleware, withObservability };