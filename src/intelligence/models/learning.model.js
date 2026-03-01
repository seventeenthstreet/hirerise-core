"use strict";

/**
 * Learning Model
 *
 * Responsible for:
 * - Estimating time required to close skill gaps
 * - ROI categorization
 * - Learning efficiency modeling
 *
 * This keeps the engine purely orchestration-focused.
 */

module.exports = {

  /**
   * Main Learning Intelligence Entry
   */
  calculateLearning({
    gap,
    cluster,
    adjustedMarketScore,
    promoScore,
    futureTrend,
    config,
  }) {

    const learningWeeks = this._estimateLearningTime({
      currentProficiency: gap.currentProficiency,
      targetProficiency: gap.targetProficiency,
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
    };
  },

  // ─────────────────────────────────────────────────────────────
  // TIME ESTIMATION
  // ─────────────────────────────────────────────────────────────

  _estimateLearningTime({
    currentProficiency,
    targetProficiency,
    cluster,
    config,
  }) {
    const {
      baseWeeksPerGap10Points,
      minWeeks,
      maxWeeks,
    } = config.learningTime;

    const clusterMultiplier =
      config.skillClusters?.[cluster]?.baseWeeksMultiplier ?? 1.0;

    const gap = Math.max(
      0,
      targetProficiency - currentProficiency
    );

    const baseWeeks =
      (gap / 10) * baseWeeksPerGap10Points;

    const finalWeeks = Math.round(
      baseWeeks * clusterMultiplier
    );

    return Math.min(
      maxWeeks,
      Math.max(minWeeks, finalWeeks)
    );
  },

  // ─────────────────────────────────────────────────────────────
  // ROI CLASSIFICATION
  // ─────────────────────────────────────────────────────────────

  _categorizeROI({
    marketScore,
    promoScore,
    learningWeeks,
    futureTrend,
    config,
  }) {
    const {
      fastGainMaxWeeks,
      fastGainMinDemand,
      strategicMinPromo,
      longTermMinFuture,
    } = config.roi;

    if (
      marketScore >= fastGainMinDemand &&
      learningWeeks <= fastGainMaxWeeks
    ) {
      return "FAST_GAIN";
    }

    if (promoScore >= strategicMinPromo) {
      return "STRATEGIC";
    }

    if (futureTrend >= longTermMinFuture) {
      return "LONG_TERM";
    }

    return "STRATEGIC";
  },

  // ─────────────────────────────────────────────────────────────
  // DIFFICULTY SCORE (0–100)
  // ─────────────────────────────────────────────────────────────

  _calculateDifficultyScore({
    gap,
    cluster,
    config,
  }) {
    const gapFactor = Math.min(
      1,
      gap.proficiencyGap / 100
    );

    const clusterMultiplier =
      config.skillClusters?.[cluster]?.baseWeeksMultiplier ?? 1;

    const rawDifficulty =
      gapFactor * 70 +
      (clusterMultiplier - 1) * 30;

    return Math.min(
      100,
      Math.max(0, Math.round(rawDifficulty))
    );
  },

  // ─────────────────────────────────────────────────────────────
  // LEARNING EFFICIENCY INDEX
  // (Economic Return Per Week)
  // ─────────────────────────────────────────────────────────────

  _calculateLearningEfficiency({
    adjustedMarketScore,
    learningWeeks,
  }) {
    if (!learningWeeks || learningWeeks <= 0) {
      return 0;
    }

    const efficiency =
      adjustedMarketScore / learningWeeks;

    return Math.min(
      100,
      parseFloat(efficiency.toFixed(2))
    );
  },

};
