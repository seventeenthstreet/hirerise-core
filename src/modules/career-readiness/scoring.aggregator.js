"use strict";

/**
 * src/modules/career-readiness/scoring.aggregator.js
 *
 * Final scoring contract layer
 * - Supabase JSONB safe
 * - deterministic fallback safe
 * - AI degradation safe
 * - dashboard contract stable
 */

const config = require("../../config/careerReadiness.weights");

class ScoringAggregator {
  aggregate(deterministicResult = {}, aiResult = {}, candidateProfile = {}) {
    const { WEIGHTS, READINESS_BANDS } = config;

    const D = deterministicResult?.scores ?? {};
    const meta = deterministicResult?.meta ?? {};
    const AI = aiResult?.data ?? {};

    const dampenedSkillDepth = this._applyConfidenceDampening(
      AI?.skill_depth_maturity?.score,
      AI?.skill_depth_maturity?.confidence
    );

    const dampenedGrowthReadiness = this._applyConfidenceDampening(
      AI?.growth_readiness_index?.score,
      AI?.growth_readiness_index?.confidence
    );

    const dimensionScores = {
      skillMatch: {
        raw: this._safe01(D.skillMatch),
        weight: WEIGHTS.skillMatch,
      },
      experienceAlignment: {
        raw: this._safe01(D.experienceAlignment),
        weight: WEIGHTS.experienceAlignment,
      },
      skillDepthMaturity: {
        raw: this._safe01(dampenedSkillDepth),
        weight: WEIGHTS.skillDepthMaturity,
      },
      marketDemandAlignment: {
        raw: this._safe01(D.marketDemandAlignment),
        weight: WEIGHTS.marketDemandAlignment,
      },
      salaryPositioning: {
        raw: this._safe01(D.salaryPositioning),
        weight: WEIGHTS.salaryPositioning,
      },
      resumeStrength: {
        raw: this._safe01(D.resumeStrength),
        weight: WEIGHTS.resumeStrength,
      },
      growthReadiness: {
        raw: this._safe01(dampenedGrowthReadiness),
        weight: WEIGHTS.growthReadiness,
      },
    };

    let crs = 0;
    const weightedBreakdown = {};

    for (const [dimension, { raw, weight }] of Object.entries(
      dimensionScores
    )) {
      const contribution = raw * weight * 100;
      crs += contribution;

      weightedBreakdown[dimension] = {
        rawScore: this._safeNumber(raw * 100),
        weight: this._safeNumber(weight),
        weightedContribution: this._safeNumber(contribution),
      };
    }

    crs = this._safeNumber(this._clampRange(crs, 0, 100));
    const readinessLevel = this._classifyReadiness(
      crs,
      READINESS_BANDS
    );

    return {
      career_readiness_score: crs,
      readiness_level: readinessLevel,
      dimension_scores: weightedBreakdown,
      skill_gaps: this._buildSkillGaps(meta),
      strength_areas: this._identifyStrengths(dimensionScores),
      promotion_probability: this._safeNumber(
        this._safe01(AI?.promotion_probability?.score) * 100
      ),
      salary_positioning_index: this._safeNumber(
        meta?.salaryPositioning?.ratio
      ),
      growth_readiness_index: this._safeNumber(
        dampenedGrowthReadiness * 100
      ),
      career_roadmap: Array.isArray(AI?.career_roadmap)
        ? AI.career_roadmap
        : [],
      explainability: {
        deterministic_factors: {
          skillMatch: meta?.skillMatch ?? {},
          experienceAlignment:
            meta?.experienceAlignment ?? {},
          salaryPositioning: meta?.salaryPositioning ?? {},
          marketDemand: meta?.marketDemand ?? {},
          certificationMatch:
            meta?.certificationMatch ?? {},
          educationAlignment:
            meta?.educationAlignment ?? {},
        },
        ai_factors: {
          skillDepthMaturity:
            AI?.skill_depth_maturity ?? {},
          growthReadiness:
            AI?.growth_readiness_index ?? {},
          promotionProbability:
            AI?.promotion_probability ?? {},
          marketRisk:
            AI?.market_risk_assessment ?? {},
          confidence_dampening_applied: true,
          dampened_values: {
            skillDepthMaturity: this._safeNumber(
              dampenedSkillDepth
            ),
            growthReadiness: this._safeNumber(
              dampenedGrowthReadiness
            ),
          },
          aiFallbackUsed: !aiResult?.success,
        },
        weight_distribution: WEIGHTS,
        formula: "CRS = Σ(dimensionScore × weight) × 100",
        score_composition: weightedBreakdown,
      },
    };
  }

  _applyConfidenceDampening(score, confidence) {
    if (typeof score !== "number") return 0;

    const safeScore = this._safe01(score);
    const safeConfidence =
      typeof confidence === "number"
        ? this._safe01(confidence)
        : 0.5;

    return safeScore * (0.5 + 0.5 * safeConfidence);
  }

  _classifyReadiness(score, bands = []) {
    return (
      bands.find((band) => score >= band.min)?.label ||
      "low"
    );
  }

  _buildSkillGaps(meta = {}) {
    const gaps = [];

    for (const skill of meta?.skillMatch?.missingCoreSkills ?? []) {
      gaps.push({
        skill,
        type: "core",
        priority: "critical",
        source: "deterministic",
      });
    }

    for (const skill of meta?.skillMatch?.missingSecondarySkills ?? []) {
      gaps.push({
        skill,
        type: "secondary",
        priority: "recommended",
        source: "deterministic",
      });
    }

    return gaps;
  }

  _identifyStrengths(dimensionScores = {}) {
    return Object.entries(dimensionScores)
      .filter(([, value]) => this._safe01(value.raw) >= 0.75)
      .map(([dimension]) => dimension);
  }

  _safe01(value) {
    return this._clampRange(Number(value) || 0, 0, 1);
  }

  _safeNumber(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return parseFloat(num.toFixed(2));
  }

  _clampRange(value, min, max) {
    return Math.min(max, Math.max(min, Number(value) || 0));
  }
}

module.exports = ScoringAggregator;