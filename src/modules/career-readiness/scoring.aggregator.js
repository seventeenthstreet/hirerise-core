const config = require("../../config/careerReadiness.weights");

class ScoringAggregator {
  aggregate(deterministicResult, aiResult, candidateProfile) {
    const { WEIGHTS, READINESS_BANDS } = config;

    const D = deterministicResult.scores;
    const AI = aiResult.data;

    // ──────────────────────────────────────────────
    // AI CONFIDENCE DAMPENING
    // ──────────────────────────────────────────────

    const dampenedSkillDepth = this._applyConfidenceDampening(
      AI.skill_depth_maturity?.score,
      AI.skill_depth_maturity?.confidence
    );

    const dampenedGrowthReadiness = this._applyConfidenceDampening(
      AI.growth_readiness_index?.score,
      AI.growth_readiness_index?.confidence
    );

    // ──────────────────────────────────────────────
    // DIMENSION DEFINITIONS (ALL RAW 0–1)
    // ──────────────────────────────────────────────

    const dimensionScores = {
      skillMatch: {
        raw: this._clamp01(D.skillMatch),
        weight: WEIGHTS.skillMatch,
      },
      experienceAlignment: {
        raw: this._clamp01(D.experienceAlignment),
        weight: WEIGHTS.experienceAlignment,
      },
      skillDepthMaturity: {
        raw: this._clamp01(dampenedSkillDepth),
        weight: WEIGHTS.skillDepthMaturity,
      },
      marketDemandAlignment: {
        raw: this._clamp01(D.marketDemandAlignment),
        weight: WEIGHTS.marketDemandAlignment,
      },
      salaryPositioning: {
        raw: this._clamp01(D.salaryPositioning),
        weight: WEIGHTS.salaryPositioning,
      },
      resumeStrength: {
        raw: this._clamp01(D.resumeStrength),
        weight: WEIGHTS.resumeStrength,
      },
      growthReadiness: {
        raw: this._clamp01(dampenedGrowthReadiness),
        weight: WEIGHTS.growthReadiness,
      },
    };

    // ──────────────────────────────────────────────
    // WEIGHTED CRS CALCULATION
    // CRS = Σ(dimensionScore × weight) × 100
    // ──────────────────────────────────────────────

    let crs = 0;
    const weightedBreakdown = {};

    for (const [dim, { raw, weight }] of Object.entries(dimensionScores)) {
      const contribution = raw * weight * 100;
      crs += contribution;

      weightedBreakdown[dim] = {
        rawScore: parseFloat((raw * 100).toFixed(2)),
        weight: weight,
        weightedContribution: parseFloat(contribution.toFixed(2)),
      };
    }

    crs = parseFloat(this._clampRange(crs, 0, 100).toFixed(2));
    const readinessLevel = this._classifyReadiness(crs, READINESS_BANDS);

    // ──────────────────────────────────────────────
    // BUILD OUTPUT OBJECT
    // ──────────────────────────────────────────────

    return {
      career_readiness_score: crs,
      readiness_level: readinessLevel,
      dimension_scores: weightedBreakdown,
      skill_gaps: this._buildSkillGaps(deterministicResult.meta),
      strength_areas: this._identifyStrengths(dimensionScores),
      promotion_probability: parseFloat(
        (this._clamp01(AI.promotion_probability?.score) * 100).toFixed(2)
      ),
      salary_positioning_index:
        deterministicResult.meta.salaryPositioning?.ratio,
      growth_readiness_index: parseFloat(
        (dampenedGrowthReadiness * 100).toFixed(2)
      ),
      career_roadmap: AI.career_roadmap || [],
      explainability: {
        deterministic_factors: {
          skillMatch: deterministicResult.meta.skillMatch,
          experienceAlignment:
            deterministicResult.meta.experienceAlignment,
          salaryPositioning:
            deterministicResult.meta.salaryPositioning,
          marketDemand: deterministicResult.meta.marketDemand,
          certificationMatch:
            deterministicResult.meta.certificationMatch,
          educationAlignment:
            deterministicResult.meta.educationAlignment,
        },
        ai_factors: {
          skillDepthMaturity: AI.skill_depth_maturity,
          growthReadiness: AI.growth_readiness_index,
          promotionProbability: AI.promotion_probability,
          marketRisk: AI.market_risk_assessment,
          confidence_dampening_applied: true,
          dampened_values: {
            skillDepthMaturity: dampenedSkillDepth,
            growthReadiness: dampenedGrowthReadiness,
          },
          aiFallbackUsed: !aiResult.success,
        },
        weight_distribution: WEIGHTS,
        formula: "CRS = Σ(dimensionScore × weight) × 100",
        score_composition: weightedBreakdown,
      },
    };
  }

  // ──────────────────────────────────────────────
  // CONFIDENCE DAMPENING
  // ──────────────────────────────────────────────

  _applyConfidenceDampening(score, confidence) {
    if (typeof score !== "number") return 0;

    const safeScore = this._clamp01(score);
    const safeConfidence =
      typeof confidence === "number"
        ? this._clamp01(confidence)
        : 0.5; // default moderate confidence

    // Balanced dampening formula
    return safeScore * (0.5 + 0.5 * safeConfidence);
  }

  // ──────────────────────────────────────────────
  // READINESS CLASSIFICATION
  // ──────────────────────────────────────────────

  _classifyReadiness(score, bands) {
    return (
      bands.find((band) => score >= band.min)?.label ||
      "Not Ready"
    );
  }

  // ──────────────────────────────────────────────
  // SKILL GAPS
  // ──────────────────────────────────────────────

  _buildSkillGaps(meta) {
    const gaps = [];

    for (const skill of meta.skillMatch?.missingCoreSkills || []) {
      gaps.push({
        skill,
        type: "core",
        priority: "critical",
        source: "deterministic",
      });
    }

    for (const skill of meta.skillMatch?.missingSecondarySkills || []) {
      gaps.push({
        skill,
        type: "secondary",
        priority: "recommended",
        source: "deterministic",
      });
    }

    return gaps;
  }

  // ──────────────────────────────────────────────
  // STRENGTH IDENTIFICATION (FIXED BUG)
  // ──────────────────────────────────────────────

  _identifyStrengths(dimensionScores) {
    return Object.entries(dimensionScores)
      .filter(([, v]) => v.raw * 100 >= 75)
      .map(([dim]) => dim);
  }

  // ──────────────────────────────────────────────
  // UTILITIES
  // ──────────────────────────────────────────────

  _clamp01(value) {
    return Math.min(1, Math.max(0, value));
  }

  _clampRange(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
}

module.exports = ScoringAggregator;
