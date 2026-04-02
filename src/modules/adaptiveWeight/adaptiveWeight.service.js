'use strict';

/**
 * adaptiveWeight.service.js
 *
 * Production-grade Adaptive Learning Engine
 * - Supabase-ready
 * - Uses normalized weight utilities
 * - Confidence-gated learning
 * - Safe + stable updates
 */

const {
  DEFAULT_WEIGHTS,
  DEFAULT_LEARNING_RATE,
  WEIGHT_BOUNDS,
  CONFIDENCE,
  PERFORMANCE,
} = require('./adaptiveWeight.constants');

const {
  validateWeightKey,
  validateOutcomePayload,
  validateManualOverride,
} = require('./adaptiveWeight.validator');

const {
  normalizeWeights,
  ensureValidWeights,
} = require('./adaptiveWeight.utils');

const logger = require('../../utils/logger');

class AdaptiveWeightService {
  constructor({ adaptiveWeightRepo }) {
    this._repo = adaptiveWeightRepo;
  }

  // ═══════════════════════════════════════════════════════════
  // 🎯 GET WEIGHTS (Controller-compatible)
  // ═══════════════════════════════════════════════════════════

  async getWeightsForScoring({
    roleFamily,
    experienceBucket,
    industryTag,
    requestId,
  }) {
    try {
      validateWeightKey({ roleFamily, experienceBucket, industryTag });

      const record = await this._repo.findByKey({
        roleFamily,
        experienceBucket,
        industryTag,
      });

      if (!record) {
        return this._defaultResponse('no_record');
      }

      // Ensure DB safety
      const safeWeights = ensureValidWeights(record.weights);

      // Manual override priority
      if (record.manualOverride === true) {
        return {
          weights: safeWeights,
          source: 'adaptive',
          meta: {
            manualOverride: true,
            freezeLearning: true,
            confidenceScore: record.confidenceScore,
            performanceScore: record.performanceScore,
            updatedAt: record.updatedAt,
          },
        };
      }

      // Confidence gate
      if (
        typeof record.confidenceScore !== 'number' ||
        record.confidenceScore < CONFIDENCE.minimumToUse
      ) {
        return this._defaultResponse('low_confidence');
      }

      return {
        weights: safeWeights,
        source: 'adaptive',
        meta: {
          confidenceScore: record.confidenceScore,
          performanceScore: record.performanceScore,
          updatedAt: record.updatedAt,
          freezeLearning: record.freezeLearning ?? false,
          manualOverride: false,
        },
      };

    } catch (err) {
      if (err.name === 'AdaptiveWeightValidationError') throw err;

      logger.error('[AdaptiveWeightService:getWeightsForScoring]', {
        requestId,
        error: err.message,
      });

      return this._defaultResponse('service_error');
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 📥 RECORD OUTCOME + LEARNING
  // ═══════════════════════════════════════════════════════════

  async recordOutcome(payload) {
    const {
      roleFamily,
      experienceBucket,
      industryTag,
      predictedScore,
      actualOutcome,
      requestId,
    } = payload;

    validateOutcomePayload(payload);

    let record = await this._repo.findByKey({
      roleFamily,
      experienceBucket,
      industryTag,
    });

    // Initialize
    if (!record) {
      record = this._buildInitialRecord(payload);
      await this._repo.upsert(record); // 🔥 Supabase style
    }

    // Freeze protection
    if (record.freezeLearning === true) {
      return {
        updated: false,
        newWeights: record.weights,
        performanceScore: record.performanceScore,
        confidenceScore: record.confidenceScore,
      };
    }

    // ── Prediction Error
    const normalizedPrediction = predictedScore / 100;
    const predictionError = actualOutcome - normalizedPrediction;

    const learningRate =
      record.learningRate ?? DEFAULT_LEARNING_RATE;

    const currentWeights = ensureValidWeights(record.weights);

    // ── Apply delta
    const delta = learningRate * predictionError;
    const updatedWeights = this._applyDelta(currentWeights, delta);

    // 🔒 Normalize (CRITICAL FIX)
    const normalizedWeights = normalizeWeights(updatedWeights);

    // ── Performance (EMA)
    const currentPerformance =
      record.performanceScore ?? PERFORMANCE.initial;

    const accuracy = 1 - Math.abs(predictionError);

    const newPerformanceScore = parseFloat(
      (
        PERFORMANCE.smoothingFactor * accuracy +
        (1 - PERFORMANCE.smoothingFactor) * currentPerformance
      ).toFixed(4)
    );

    // ── Confidence
    const currentConfidence =
      record.confidenceScore ?? CONFIDENCE.initial;

    const newConfidenceScore = this._adjustConfidence(
      currentConfidence,
      newPerformanceScore
    );

    const updatedRecord = {
      ...record,
      weights: normalizedWeights,
      performanceScore: newPerformanceScore,
      confidenceScore: newConfidenceScore,
    };

    await this._repo.upsert(updatedRecord);

    return {
      updated: true,
      newWeights: normalizedWeights,
      performanceScore: newPerformanceScore,
      confidenceScore: newConfidenceScore,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // 🛠️ MANUAL OVERRIDE
  // ═══════════════════════════════════════════════════════════

  async applyManualOverride(payload) {
    validateManualOverride(payload);

    const normalized = normalizeWeights(payload.weights);

    const record = {
      ...payload,
      weights: normalized,
      manualOverride: true,
      freezeLearning: true,
    };

    await this._repo.upsert(record);

    return { weights: normalized, manualOverride: true };
  }

  async releaseManualOverride(payload) {
    validateWeightKey(payload);

    await this._repo.update(payload, {
      manualOverride: false,
      freezeLearning: false,
    });

    return { released: true };
  }

  // ═══════════════════════════════════════════════════════════
  // 🔧 HELPERS
  // ═══════════════════════════════════════════════════════════

  _defaultResponse(reason) {
    return {
      weights: { ...DEFAULT_WEIGHTS },
      source: 'default',
      meta: { reason },
    };
  }

  _buildInitialRecord({ roleFamily, experienceBucket, industryTag }) {
    return {
      roleFamily,
      experienceBucket,
      industryTag,
      weights: { ...DEFAULT_WEIGHTS },
      performanceScore: PERFORMANCE.initial,
      confidenceScore: CONFIDENCE.initial,
      learningRate: DEFAULT_LEARNING_RATE,
      freezeLearning: false,
      manualOverride: false,
      softDeleted: false,
    };
  }

  _applyDelta(weights, delta) {
    const result = {};

    for (const key of Object.keys(weights)) {
      const nudged = weights[key] + delta;

      result[key] = Math.min(
        WEIGHT_BOUNDS.max,
        Math.max(WEIGHT_BOUNDS.min, nudged)
      );
    }

    return result;
  }

  _adjustConfidence(currentConfidence, performance) {
    let updated;

    if (performance > PERFORMANCE.degradationThreshold) {
      updated = currentConfidence + CONFIDENCE.incrementPerGood;
    } else {
      updated = currentConfidence - CONFIDENCE.decayPerBad;
    }

    return parseFloat(
      Math.min(CONFIDENCE.cap, Math.max(0.01, updated)).toFixed(4)
    );
  }
}

module.exports = AdaptiveWeightService;
