'use strict';

/**
 * Learning Model (Production Optimized)
 */

module.exports = {

  calculateLearning({
    gap = {},
    cluster = 'default',
    adjustedMarketScore = 0,
    promoScore = 0,
    futureTrend = 0,
    config = {},
  }) {

    const learningWeeks = this._estimateLearningTime({
      currentProficiency: safe(gap.currentProficiency),
      targetProficiency: safe(gap.targetProficiency),
      cluster,
      config,
    });

    const roiCategory = this._categorizeROI({
      marketScore: adjustedMarketScore,
      promoScore,
      learningWeeks,
      futureTrend,
      config,
    });

    const difficultyScore = this._calculateDifficultyScore({
      gap,
      cluster,
      config,
    });

    const efficiencyIndex = this._calculateLearningEfficiency({
      adjustedMarketScore,
      learningWeeks,
    });

    return {
      estimatedLearningTimeWeeks: learningWeeks,
      roiCategory,
      difficultyScore,
      efficiencyIndex,
      meta: {
        evaluatedAt: new Date().toISOString()
      }
    };
  },

  // ─────────────────────────────────────────────
  // TIME ESTIMATION
  // ─────────────────────────────────────────────

  _estimateLearningTime({
    currentProficiency,
    targetProficiency,
    cluster,
    config,
  }) {
    const learningConfig = config.learningTime || {};

    const baseWeeksPerGap10Points =
      learningConfig.baseWeeksPerGap10Points ?? 2;

    const minWeeks = learningConfig.minWeeks ?? 1;
    const maxWeeks = learningConfig.maxWeeks ?? 52;

    const clusterMultiplier =
      config.skillClusters?.[cluster]?.baseWeeksMultiplier ?? 1.0;

    const gap = Math.max(0, targetProficiency - currentProficiency);

    const baseWeeks = (gap / 10) * baseWeeksPerGap10Points;

    const finalWeeks = Math.round(baseWeeks * clusterMultiplier);

    return clamp(finalWeeks, minWeeks, maxWeeks);
  },

  // ─────────────────────────────────────────────
  // ROI CLASSIFICATION (IMPROVED)
  // ─────────────────────────────────────────────

  _categorizeROI({
    marketScore,
    promoScore,
    learningWeeks,
    futureTrend,
    config,
  }) {
    const roiConfig = config.roi || {};

    const fastGainMaxWeeks = roiConfig.fastGainMaxWeeks ?? 8;
    const fastGainMinDemand = roiConfig.fastGainMinDemand ?? 70;
    const strategicMinPromo = roiConfig.strategicMinPromo ?? 60;
    const longTermMinFuture = roiConfig.longTermMinFuture ?? 65;

    // Score-based approach (more flexible)
    let score = 0;

    if (marketScore >= fastGainMinDemand) score += 40;
    if (learningWeeks <= fastGainMaxWeeks) score += 30;
    if (promoScore >= strategicMinPromo) score += 20;
    if (futureTrend >= longTermMinFuture) score += 10;

    if (score >= 70) return 'FAST_GAIN';
    if (score >= 40) return 'STRATEGIC';
    return 'LONG_TERM';
  },

  // ─────────────────────────────────────────────
  // DIFFICULTY SCORE (FIXED)
  // ─────────────────────────────────────────────

  _calculateDifficultyScore({
    gap,
    cluster,
    config,
  }) {
    const gapFactor = clamp((gap.proficiencyGap ?? 0) / 100, 0, 1);

    const clusterMultiplier =
      config.skillClusters?.[cluster]?.baseWeeksMultiplier ?? 1;

    const normalizedCluster = clamp(clusterMultiplier / 2, 0, 1);

    const difficulty =
      (gapFactor * 0.7 + normalizedCluster * 0.3) * 100;

    return Math.round(difficulty);
  },

  // ─────────────────────────────────────────────
  // LEARNING EFFICIENCY INDEX
  // ─────────────────────────────────────────────

  _calculateLearningEfficiency({
    adjustedMarketScore,
    learningWeeks,
  }) {
    if (!learningWeeks || learningWeeks <= 0) return 0;

    const efficiency = adjustedMarketScore / learningWeeks;

    return clamp(parseFloat(efficiency.toFixed(2)), 0, 100);
  },

};

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function safe(value) {
  return typeof value === 'number' && !isNaN(value) ? value : 0;
}