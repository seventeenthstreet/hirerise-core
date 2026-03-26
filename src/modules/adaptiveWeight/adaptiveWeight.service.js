// adaptiveWeight.service.js

const {
  DEFAULT_WEIGHTS,
  DEFAULT_LEARNING_RATE,
  WEIGHT_BOUNDS,
  CONFIDENCE,
  PERFORMANCE,
  OUTCOME,
} = require("./adaptiveWeight.constants");

const {
  validateWeightKey,
  validateOutcomePayload,
  validateManualOverride,
} = require("./adaptiveWeight.validator");

const logger = require("../../utils/logger");

/**
 * AdaptiveWeightService
 *
 * Stability-first adaptive reinforcement engine.
 * No external ML libs.
 * Conservative learning.
 * Confidence-gated application.
 */
class AdaptiveWeightService {
  constructor({ adaptiveWeightRepo }) {
    this._repo = adaptiveWeightRepo;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC: WEIGHT RETRIEVAL
  // ═══════════════════════════════════════════════════════════════════════════

  async getWeightsForScoring(roleFamily, experienceBucket, industryTag) {
    try {
      validateWeightKey({ roleFamily, experienceBucket, industryTag });

      const record = await this._repo.findByKey(
        roleFamily,
        experienceBucket,
        industryTag
      );

      if (!record) {
        return this._defaultResponse("no_record");
      }

      // Manual override ALWAYS takes precedence
      if (record.manualOverride === true) {
        return {
          weights: record.weights,
          source: "adaptive",
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
        typeof record.confidenceScore !== "number" ||
        record.confidenceScore < CONFIDENCE.minimumToUse
      ) {
        return this._defaultResponse("low_confidence");
      }

      return {
        weights: record.weights,
        source: "adaptive",
        meta: {
          confidenceScore: record.confidenceScore,
          performanceScore: record.performanceScore,
          updatedAt: record.updatedAt,
          freezeLearning: record.freezeLearning ?? false,
          manualOverride: false,
        },
      };
    } catch (err) {
      if (err.name === "AdaptiveWeightValidationError") throw err;
      logger.error(
        "[AdaptiveWeight] getWeightsForScoring failed — using defaults",
        { error: err.message }
      );
      return this._defaultResponse("service_error");
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC: RECORD OUTCOME + LEARN
  // ═══════════════════════════════════════════════════════════════════════════

  async recordOutcome({
    roleFamily,
    experienceBucket,
    industryTag,
    predictedScore,
    actualOutcome,
  }) {
    validateOutcomePayload({
      roleFamily,
      experienceBucket,
      industryTag,
      predictedScore,
      actualOutcome,
    });

    let record = await this._repo.findByKey(
      roleFamily,
      experienceBucket,
      industryTag
    );

    // Initialize if not exists
    if (!record) {
      record = this._buildInitialRecord(
        roleFamily,
        experienceBucket,
        industryTag
      );
      await this._repo.create(
        roleFamily,
        experienceBucket,
        industryTag,
        record
      );
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

    // ── Step 1: Prediction Error ─────────────────────────────────────────────
    const normalizedPrediction = predictedScore / 100;
    const predictionError = actualOutcome - normalizedPrediction;

    const learningRate =
      record.learningRate ?? DEFAULT_LEARNING_RATE;

    const currentWeights =
      record.weights && typeof record.weights === "object"
        ? record.weights
        : DEFAULT_WEIGHTS;

    // ── Step 2 & 3: Apply Uniform Delta + Clamp ─────────────────────────────
    const delta = learningRate * predictionError;
    const updatedWeights = this._applyDeltaAndClamp(
      currentWeights,
      delta
    );

    // ── Step 4: Normalize ───────────────────────────────────────────────────
    const normalizedWeights = normalizeWeights(updatedWeights);

    // ── Step 5: EMA Performance Score ───────────────────────────────────────
    const currentPerformance =
      typeof record.performanceScore === "number"
        ? record.performanceScore
        : PERFORMANCE.initial;

    const predictionAccuracy = 1 - Math.abs(predictionError);

    const newPerformanceScore = parseFloat(
      (
        PERFORMANCE.smoothingFactor * predictionAccuracy +
        (1 - PERFORMANCE.smoothingFactor) * currentPerformance
      ).toFixed(4)
    );

    // ── Step 6: Confidence Adjustment ───────────────────────────────────────
    const currentConfidence =
      typeof record.confidenceScore === "number"
        ? record.confidenceScore
        : CONFIDENCE.initial;

    const newConfidenceScore = this._adjustConfidence(
      currentConfidence,
      newPerformanceScore
    );

    const patch = {
      weights: normalizedWeights,
      performanceScore: newPerformanceScore,
      confidenceScore: newConfidenceScore,
    };

    await this._repo.update(
      roleFamily,
      experienceBucket,
      industryTag,
      patch
    );

    return {
      updated: true,
      newWeights: normalizedWeights,
      performanceScore: newPerformanceScore,
      confidenceScore: newConfidenceScore,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC: MANUAL OVERRIDE
  // ═══════════════════════════════════════════════════════════════════════════

  async applyManualOverride({
    roleFamily,
    experienceBucket,
    industryTag,
    weights,
  }) {
    validateManualOverride({
      roleFamily,
      experienceBucket,
      industryTag,
      weights,
    });

    const normalized = normalizeWeights(weights);

    const patch = {
      weights: normalized,
      manualOverride: true,
      freezeLearning: true,
    };

    const existing = await this._repo.findByKey(
      roleFamily,
      experienceBucket,
      industryTag
    );

    if (!existing) {
      const initial = this._buildInitialRecord(
        roleFamily,
        experienceBucket,
        industryTag
      );
      await this._repo.create(
        roleFamily,
        experienceBucket,
        industryTag,
        { ...initial, ...patch }
      );
    } else {
      await this._repo.update(
        roleFamily,
        experienceBucket,
        industryTag,
        patch
      );
    }

    return { weights: normalized, manualOverride: true };
  }

  async releaseManualOverride({
    roleFamily,
    experienceBucket,
    industryTag,
  }) {
    validateWeightKey({ roleFamily, experienceBucket, industryTag });

    await this._repo.update(
      roleFamily,
      experienceBucket,
      industryTag,
      {
        manualOverride: false,
        freezeLearning: false,
      }
    );

    return { released: true };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  _defaultResponse(reason) {
    return {
      weights: { ...DEFAULT_WEIGHTS },
      source: "default",
      meta: { reason },
    };
  }

  _buildInitialRecord(roleFamily, experienceBucket, industryTag) {
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

  _applyDeltaAndClamp(weights, delta) {
    const result = {};

    for (const [key, value] of Object.entries(weights)) {
      const nudged = value + delta;
      result[key] = Math.min(
        WEIGHT_BOUNDS.max,
        Math.max(WEIGHT_BOUNDS.min, nudged)
      );
    }

    return result;
  }

  _adjustConfidence(currentConfidence, newPerformanceScore) {
    let updated;

    if (newPerformanceScore > PERFORMANCE.degradationThreshold) {
      updated = currentConfidence + CONFIDENCE.incrementPerGood;
    } else {
      updated = currentConfidence - CONFIDENCE.decayPerBad;
    }

    // 🔒 Never allow confidence to reach absolute zero
    const MIN_CONFIDENCE_FLOOR = 0.01;

    return parseFloat(
      Math.min(CONFIDENCE.cap, Math.max(MIN_CONFIDENCE_FLOOR, updated))
        .toFixed(4)
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// normalizeWeights Utility
// ═══════════════════════════════════════════════════════════════════════════

function normalizeWeights(weightsObj) {
  if (
    !weightsObj ||
    typeof weightsObj !== "object" ||
    Array.isArray(weightsObj)
  ) {
    throw new Error("normalizeWeights: input must be a plain object.");
  }

  const entries = Object.entries(weightsObj);

  if (entries.length === 0) {
    throw new Error("normalizeWeights: weights object must not be empty.");
  }

  for (const [key, value] of entries) {
    if (typeof value !== "number" || isNaN(value) || value < 0) {
      throw new Error(
        `normalizeWeights: invalid value for key "${key}": ${value}`
      );
    }
  }

  const total = entries.reduce((sum, [, v]) => sum + v, 0);

  if (total === 0) {
    throw new Error(
      "normalizeWeights: sum of weights is zero — cannot normalize."
    );
  }

  const normalized = {};

  for (const [key, value] of entries) {
    normalized[key] = parseFloat((value / total).toFixed(6));
  }

  const normalizedSum = Object.values(normalized).reduce(
    (s, v) => s + v,
    0
  );

  const residual = parseFloat((1 - normalizedSum).toFixed(6));

  if (residual !== 0) {
    const largestKey = Object.entries(normalized).reduce(
      (max, [k, v]) => (v > max[1] ? [k, v] : max),
      ["", -Infinity]
    )[0];

    normalized[largestKey] = parseFloat(
      (normalized[largestKey] + residual).toFixed(6)
    );
  }

  return normalized;
}

module.exports = { AdaptiveWeightService, normalizeWeights };








