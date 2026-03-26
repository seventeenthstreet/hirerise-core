'use strict';

const observabilityRepo = require('../../repositories/ai-observability.repository');
const AILogger = require('../observability/logger');

/**
 * shadow-model.service.js
 *
 * Shadow Model Testing Framework.
 *
 * DESIGN:
 *   On configured % of traffic (default 5%), the system SILENTLY runs a candidate
 *   model alongside the primary model. The shadow result:
 *     - Is stored in ai_shadow_testing (never returned to user)
 *     - Has key metrics compared against primary (score delta, latency delta, cost delta)
 *     - Powers a promotion decision: if shadow metrics are better, promote candidate
 *
 *   The user ALWAYS receives the primary model's output — shadow is never visible.
 *
 * ROLLOUT STRATEGY:
 *   Phase 1 (0–5%): Shadow on 5% traffic. Collect 1,000+ comparison pairs.
 *   Phase 2 (5–10%): Increase to 10% if Phase 1 shows no regressions.
 *   Phase 3: Promote candidate to primary in model-registry.js. Circuit breaker
 *             automatically uses new primary. Old primary becomes first fallback.
 *
 * WHAT IS COMPARED:
 *   - Score delta: |shadow.score - primary.score| / primary.score
 *   - Latency delta: shadow.latencyMs - primary.latencyMs
 *   - Token delta: shadow.tokens - primary.tokens (cost proxy)
 *   - Confidence delta: shadow.confidence - primary.confidence
 *   - Error rate: does shadow fail when primary succeeds?
 *
 * COST:
 *   Shadow runs on 5% of traffic = 5% additional AI API cost for that feature.
 *   This is acceptable given the value of safe model promotion.
 *   Reduce to 1% for cost-sensitive deployments (set shadowSampleRate).
 */

const SHADOW_CONFIG = {
  shadowSampleRate: 0.05,       // 5% of calls run shadow
  maxShadowLatencyMs: 10000,    // Abandon shadow call if it exceeds this
  storeRawOutputs: false,       // Never store raw outputs (PII concern); store only metrics
};

class ShadowModelService {
  /**
   * Conditionally run a shadow model alongside the primary call.
   *
   * @param {Object} config
   * @param {string} config.feature
   * @param {string} config.primaryModel
   * @param {string} config.shadowModel  - candidate model to test
   * @param {string} config.userId
   * @param {string} [config.correlationId]
   * @param {Function} primaryResult  - already-completed primary result object
   * @param {Function} shadowFn       - async () => { result, tokensInput, tokensOutput, confidenceScore }
   */
  async runShadowIfSampled(config, primaryResult, shadowFn) {
    if (Math.random() >= SHADOW_CONFIG.shadowSampleRate) return;
    if (!config.shadowModel) return;

    // Fire shadow call asynchronously — does NOT block primary response
    setImmediate(() => {
      this._executeShadow(config, primaryResult, shadowFn).catch(err => {
        console.error('[ShadowModel] Shadow execution error:', err.message);
      });
    });
  }

  async _executeShadow(config, primaryResult, shadowFn) {
    const { feature, primaryModel, shadowModel, userId, correlationId } = config;
    const shadowTimer = AILogger.startTimer();
    let shadowOutput = null;
    let shadowError = null;

    // Enforce max latency budget for shadow calls
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('SHADOW_TIMEOUT')), SHADOW_CONFIG.maxShadowLatencyMs)
    );

    try {
      shadowOutput = await Promise.race([shadowFn(), timeoutPromise]);
    } catch (err) {
      shadowError = { code: err.message === 'SHADOW_TIMEOUT' ? 'TIMEOUT' : 'ERROR', message: err.message };
    }

    const shadowLatencyMs = Math.round(AILogger.elapsedMs(shadowTimer));

    // Compute comparison metrics
    const comparison = this._compareOutputs(primaryResult, shadowOutput, {
      primaryLatencyMs: primaryResult?.latencyMs || 0,
      shadowLatencyMs,
      primaryModel,
      shadowModel,
    });

    await observabilityRepo.writeShadowTestResult({
      feature,
      userId,
      correlationId: correlationId || null,
      primaryModel,
      shadowModel,
      shadowSuccess: !shadowError,
      shadowError: shadowError?.code || null,
      shadowLatencyMs,
      comparison,
    }).catch(err => {
      console.error('[ShadowModel] Failed to write shadow result:', err.message);
    });
  }

  _compareOutputs(primary, shadow, meta) {
    if (!primary || !shadow) {
      return {
        comparable: false,
        reason: !primary ? 'no_primary' : 'no_shadow',
        ...meta,
      };
    }

    const scoreDeltaAbs = (primary.outputSummary?.score != null && shadow.outputSummary?.score != null)
      ? Math.abs(shadow.outputSummary.score - primary.outputSummary.score)
      : null;
    const scoreDeltaPct = (scoreDeltaAbs != null && primary.outputSummary.score > 0)
      ? +(scoreDeltaAbs / primary.outputSummary.score * 100).toFixed(2)
      : null;

    const salaryDeltaAbs = (primary.outputSummary?.salaryMedian != null && shadow.outputSummary?.salaryMedian != null)
      ? Math.abs(shadow.outputSummary.salaryMedian - primary.outputSummary.salaryMedian)
      : null;

    const confidenceDelta = (primary.confidenceScore != null && shadow.confidenceScore != null)
      ? +(shadow.confidenceScore - primary.confidenceScore).toFixed(4)
      : null;

    const tokenDelta = ((shadow.tokensInput || 0) + (shadow.tokensOutput || 0))
      - ((primary.tokensInput || 0) + (primary.tokensOutput || 0));

    const latencyDeltaMs = meta.shadowLatencyMs - meta.primaryLatencyMs;

    return {
      comparable: true,
      scoreDeltaAbs,
      scoreDeltaPct,
      salaryDeltaAbs,
      confidenceDelta,
      tokenDelta,
      latencyDeltaMs,
      shadowFaster: latencyDeltaMs < 0,
      shadowCheaper: tokenDelta < 0,
      shadowBetterScore: scoreDeltaAbs != null
        ? shadow.outputSummary.score > primary.outputSummary.score
        : null,
      ...meta,
    };
  }

  /**
   * Get shadow comparison summary for a feature + candidate model.
   * Used by admin dashboard to inform promotion decisions.
   */
  async getShadowSummary(feature, shadowModel, { days = 14 } = {}) {
    const results = await observabilityRepo.getShadowTestResults(feature, shadowModel, days);

    if (results.length === 0) {
      return { feature, shadowModel, status: 'no_data', sampleCount: 0 };
    }

    const successful = results.filter(r => r.shadowSuccess && r.comparison?.comparable);
    const successRate = results.length > 0 ? successful.length / results.length : 0;

    const avgScoreDelta = this._avg(successful.map(r => r.comparison.scoreDeltaPct).filter(v => v != null));
    const avgLatencyDelta = this._avg(successful.map(r => r.comparison.latencyDeltaMs).filter(v => v != null));
    const avgTokenDelta = this._avg(successful.map(r => r.comparison.tokenDelta).filter(v => v != null));
    const avgConfDelta = this._avg(successful.map(r => r.comparison.confidenceDelta).filter(v => v != null));

    const promotionRecommendation = this._evaluatePromotion({
      successRate,
      avgScoreDelta,
      avgLatencyDelta,
      avgTokenDelta,
      sampleCount: successful.length,
    });

    return {
      feature,
      shadowModel,
      sampleCount: results.length,
      comparableSamples: successful.length,
      successRate: +successRate.toFixed(4),
      avgScoreDeltaPct: avgScoreDelta,
      avgLatencyDeltaMs: avgLatencyDelta ? Math.round(avgLatencyDelta) : null,
      avgTokenDelta: avgTokenDelta ? Math.round(avgTokenDelta) : null,
      avgConfidenceDelta: avgConfDelta,
      promotionRecommendation,
    };
  }

  _evaluatePromotion({ successRate, avgScoreDelta, avgLatencyDelta, avgTokenDelta, sampleCount }) {
    if (sampleCount < 100) return { recommend: false, reason: 'INSUFFICIENT_SAMPLES', minRequired: 100 };
    if (successRate < 0.95) return { recommend: false, reason: 'HIGH_ERROR_RATE', successRate };

    const scoreImproved = avgScoreDelta == null || avgScoreDelta <= 5; // within 5% delta acceptable
    const latencyAcceptable = avgLatencyDelta == null || avgLatencyDelta < 500; // <500ms slower
    const costBetter = avgTokenDelta == null || avgTokenDelta <= 0; // same or fewer tokens

    if (scoreImproved && latencyAcceptable && costBetter) {
      return { recommend: true, reason: 'ALL_METRICS_ACCEPTABLE' };
    }

    return {
      recommend: false,
      reason: 'METRICS_REGRESSION',
      details: { scoreImproved, latencyAcceptable, costBetter },
    };
  }

  _avg(arr) {
    if (!arr || arr.length === 0) return null;
    return +(arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(4);
  }
}

module.exports = new ShadowModelService();








