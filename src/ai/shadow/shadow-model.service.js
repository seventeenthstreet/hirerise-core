'use strict';

const observabilityRepo = require('../../repositories/ai-observability.repository');
const AILogger = require('../observability/logger'); // ✅ FIXED: was 'ai-logger', file is named 'logger'
const logger = require('../../utils/logger');

const SHADOW_CONFIG = {
  shadowSampleRate: 0.05,
  maxShadowLatencyMs: 10000,
};

class ShadowModelService {

  async runShadowIfSampled(config, primaryResult, shadowFn) {
    if (!this._shouldSample(config.feature)) return;
    if (!config.shadowModel) return;

    setImmediate(() => {
      this._executeShadow(config, primaryResult, shadowFn)
        .catch(err => {
          logger.error('[ShadowModel] execution error', {
            error: err.message,
          });
        });
    });
  }

  async _executeShadow(config, primaryResult, shadowFn) {
    const { feature, primaryModel, shadowModel, userId, correlationId } = config;

    const timer = AILogger.startTimer();

    let shadowOutput = null;
    let shadowError = null;

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('SHADOW_TIMEOUT')), SHADOW_CONFIG.maxShadowLatencyMs)
    );

    try {
      shadowOutput = await Promise.race([shadowFn(), timeoutPromise]);
    } catch (err) {
      shadowError = {
        code: err.message === 'SHADOW_TIMEOUT' ? 'TIMEOUT' : 'ERROR',
        message: err.message,
      };
    }

    const shadowLatencyMs = Math.round(AILogger.elapsedMs(timer));

    const comparison = this._compareOutputs(primaryResult, shadowOutput, {
      primaryLatencyMs: primaryResult?.latencyMs || 0,
      shadowLatencyMs,
      primaryModel,
      shadowModel,
    });

    // ✅ timeout-safe DB write
    await Promise.race([
      observabilityRepo.writeShadowTestResult({
        feature,
        userId,
        correlationId: correlationId || null,
        primaryModel,
        shadowModel,
        shadowSuccess: !shadowError,
        shadowError: shadowError?.code || null,
        shadowLatencyMs,
        comparison,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 2000)
      ),
    ]).catch(err => {
      logger.error('[ShadowModel] write failed', {
        error: err.message,
      });
    });
  }

  // ─────────────────────────────
  // SAFE COMPARISON
  // ─────────────────────────────

  _compareOutputs(primary, shadow, meta) {
    if (!primary || !shadow) {
      return {
        comparable: false,
        reason: !primary ? 'no_primary' : 'no_shadow',
        ...meta,
      };
    }

    const pScore = Number(primary.outputSummary?.score);
    const sScore = Number(shadow.outputSummary?.score);

    const scoreDeltaAbs =
      Number.isFinite(pScore) && Number.isFinite(sScore)
        ? Math.abs(sScore - pScore)
        : null;

    const scoreDeltaPct =
      scoreDeltaAbs != null && pScore > 0
        ? +(scoreDeltaAbs / pScore * 100).toFixed(2)
        : null;

    const salaryDeltaAbs =
      Number.isFinite(primary.outputSummary?.salaryMedian) &&
      Number.isFinite(shadow.outputSummary?.salaryMedian)
        ? Math.abs(
            shadow.outputSummary.salaryMedian -
            primary.outputSummary.salaryMedian
          )
        : null;

    const confidenceDelta =
      Number.isFinite(primary.confidenceScore) &&
      Number.isFinite(shadow.confidenceScore)
        ? +(shadow.confidenceScore - primary.confidenceScore).toFixed(4)
        : null;

    const tokenDelta =
      ((shadow.tokensInput || 0) + (shadow.tokensOutput || 0)) -
      ((primary.tokensInput || 0) + (primary.tokensOutput || 0));

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
      shadowBetterScore:
        scoreDeltaAbs != null ? sScore > pScore : null,
      ...meta,
    };
  }

  // ─────────────────────────────
  // SUMMARY
  // ─────────────────────────────

  async getShadowSummary(feature, shadowModel, { days = 14 } = {}) {
    const results = await observabilityRepo.getShadowTestResults(feature, shadowModel, days);

    if (!results.length) {
      return { feature, shadowModel, status: 'no_data', sampleCount: 0 };
    }

    const successful = results.filter(r => r.shadowSuccess && r.comparison?.comparable);

    const successRate = results.length
      ? successful.length / results.length
      : 0;

    return {
      feature,
      shadowModel,
      sampleCount: results.length,
      comparableSamples: successful.length,
      successRate: +successRate.toFixed(4),
      avgScoreDeltaPct: this._avg(successful.map(r => r.comparison.scoreDeltaPct)),
      avgLatencyDeltaMs: this._avg(successful.map(r => r.comparison.latencyDeltaMs)),
      avgTokenDelta: this._avg(successful.map(r => r.comparison.tokenDelta)),
      avgConfidenceDelta: this._avg(successful.map(r => r.comparison.confidenceDelta)),
      promotionRecommendation: this._evaluatePromotion({
        successRate,
        avgScoreDelta: this._avg(successful.map(r => r.comparison.scoreDeltaPct)),
        avgLatencyDelta: this._avg(successful.map(r => r.comparison.latencyDeltaMs)),
        avgTokenDelta: this._avg(successful.map(r => r.comparison.tokenDelta)),
        sampleCount: successful.length,
      }),
    };
  }

  // ─────────────────────────────
  // SAMPLING (DETERMINISTIC)
  // ─────────────────────────────

  _shouldSample(key = '') {
    let hash = 0;

    for (let i = 0; i < key.length; i++) {
      hash = (hash << 5) - hash + key.charCodeAt(i);
      hash |= 0;
    }

    return Math.abs(hash % 20) === 0; // ~5%
  }

  _evaluatePromotion({ successRate, avgScoreDelta, avgLatencyDelta, avgTokenDelta, sampleCount }) {
    if (sampleCount < 100) return { recommend: false, reason: 'INSUFFICIENT_SAMPLES' };
    if (successRate < 0.95) return { recommend: false, reason: 'HIGH_ERROR_RATE' };

    const scoreOK = avgScoreDelta == null || avgScoreDelta <= 5;
    const latencyOK = avgLatencyDelta == null || avgLatencyDelta < 500;
    const costOK = avgTokenDelta == null || avgTokenDelta <= 0;

    if (scoreOK && latencyOK && costOK) {
      return { recommend: true, reason: 'ALL_METRICS_ACCEPTABLE' };
    }

    return {
      recommend: false,
      reason: 'METRICS_REGRESSION',
      details: { scoreOK, latencyOK, costOK },
    };
  }

  _avg(arr) {
    const vals = arr.filter(v => v != null);
    if (!vals.length) return null;
    return +(vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(4);
  }
}

module.exports = new ShadowModelService();