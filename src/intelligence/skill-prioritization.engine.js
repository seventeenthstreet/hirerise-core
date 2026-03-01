"use strict";

const config = require("../config/skillPriorityWeights");
const logger = require("../utils/logger");

const promotionModel = require("./models/promotion.model");
const confidenceModel = require("./models/confidence.model");
const synergyModel = require("./models/synergy.model");
const explainabilityModel = require("./models/explainability.model");
const learningModel = require("./models/learning.model");

class SkillPrioritizationEngine {
  constructor({
    roleSkillMatrixRepo,
    careerGraphRepo,
    skillMarketRepo,
    userRepo,
  }) {
    this._roleSkillMatrixRepo = roleSkillMatrixRepo;
    this._careerGraphRepo = careerGraphRepo;
    this._skillMarketRepo = skillMarketRepo;
    this._userRepo = userRepo;
  }

  // ═══════════════════════════════════════════════════════════════════
  // MAIN ENTRY
  // ═══════════════════════════════════════════════════════════════════

  async run(input, options = {}) {
    const startTime = Date.now();

    const profile = this.validateInput(input);

    const [
      roleSkillMatrix,
      marketData,
      salaryData,
      careerGraphData,
      userRecord,
    ] = await Promise.all([
      this.fetchRoleSkillMatrix(
        profile.targetRoleId,
        profile.currentRoleId
      ),
      this.fetchMarketDemandData(profile.targetRoleId),
      this.fetchSalaryImpactData(profile.targetRoleId),
      this._careerGraphRepo
        .getCareerPath(
          profile.currentRoleId,
          profile.targetRoleId
        )
        .catch(() => null),
      this._userRepo.findById(profile.userId).catch(() => null),
    ]);

    const isPremium =
      options.isPremium ?? userRecord?.isPremium ?? false;

    const skillGaps = this.computeSkillGap(
      profile.skills,
      roleSkillMatrix
    );

    const dependencyMap =
      await this.resolveSkillDependencies(
        skillGaps.map((g) => g.skillId),
        careerGraphData
      );

    // ═══════════════════════════════════════════════════════════════════
    // SCORING PIPELINE
    // ═══════════════════════════════════════════════════════════════════

    const scoredSkills = skillGaps.map((gap) => {

      const marketScore = this._safeGet(
        marketData,
        gap.skillId,
        "demandScore",
        50
      );

      const salaryScore = this._safeGet(
        salaryData,
        gap.skillId,
        "salaryDelta",
        0
      );

      const promoScore = this._safeGet(
        marketData,
        gap.skillId,
        "promotionBoost",
        0
      );

      const cluster = this._safeGet(
        marketData,
        gap.skillId,
        "cluster",
        "CORE"
      );

      const futureTrend = this._safeGet(
        marketData,
        gap.skillId,
        "futureTrend",
        50
      );

      const currentProf = gap.currentProficiency;

      const isGateway =
        dependencyMap.gatewaySkills.has(gap.skillId);

      // Contextual demand adjustment
      const adjustedMarketScore =
        this._applyContextualAdjustments(
          marketScore,
          gap.skillType,
          cluster,
          profile.experienceYears,
          profile.resumeScore
        );

      // Base weighted economic score
      const baseScore =
        config.marketDemandWeight * adjustedMarketScore +
        config.salaryImpactWeight * salaryScore +
        config.promotionWeight * promoScore;

      // Gap intensity boost
      const gapFactor = Math.min(
        1,
        Math.max(0, gap.proficiencyGap / 100)
      );

      let adjustedScore =
        baseScore *
        (1 + gapFactor * config.gapWeight);

      // Gateway acceleration
      if (isGateway) {
        adjustedScore *=
          config.careerAccelerationMultiplier;
      }

      adjustedScore = Math.min(100, adjustedScore);

      // Proficiency diminishing return
      const finalScore =
        this.applyProficiencyOffset(
          adjustedScore,
          currentProf
        );

      // 🔥 External Learning Model
      const learningInsight =
        learningModel.calculateLearning({
          gap,
          cluster,
          adjustedMarketScore,
          promoScore,
          futureTrend,
          config,
        });

      return {
        skillId: gap.skillId,
        skillName: gap.skillName,

        priorityScore: parseFloat(
          finalScore.toFixed(2)
        ),

        priorityLevel:
          this._classifyPriority(finalScore),

        marketDemandScore: adjustedMarketScore,
        salaryImpactScore: salaryScore,
        promotionBoostScore: promoScore,
        currentProficiency: currentProf,

        // Learning Intelligence
        estimatedLearningTimeWeeks:
          learningInsight.estimatedLearningTimeWeeks,

        roiCategory:
          learningInsight.roiCategory,

        difficultyScore:
          learningInsight.difficultyScore,

        learningEfficiencyIndex:
          learningInsight.efficiencyIndex,

        cluster,

        dependencySkills:
          dependencyMap.dependencies[
            gap.skillId
          ] ?? [],
      };
    });

    scoredSkills.sort(
      (a, b) => b.priorityScore - a.priorityScore
    );

    // ═══════════════════════════════════════════════════════════════════
    // SKILL SYNERGY
    // ═══════════════════════════════════════════════════════════════════

    synergyModel.applySkillSynergy({
      scoredSkills,
      profile,
      config,
    });

    // ═══════════════════════════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════════════════════════

    const summary =
      this._buildSummary(scoredSkills);

    // ═══════════════════════════════════════════════════════════════════
    // PROMOTION MODEL
    // ═══════════════════════════════════════════════════════════════════

    const careerPathInsight =
      promotionModel.calculatePromotionProbability({
        scoredSkills,
        dependencyMap,
        careerGraphData,
        profile,
        config,
      });

    // ═══════════════════════════════════════════════════════════════════
    // CONFIDENCE MODEL
    // ═══════════════════════════════════════════════════════════════════

    const confidenceInsight =
      confidenceModel.calculateConfidence({
        scoredSkills,
        dependencyMap,
        careerGraphData,
        profile,
        marketData,
        config,
      });

    // ═══════════════════════════════════════════════════════════════════
    // EXPLAINABILITY
    // ═══════════════════════════════════════════════════════════════════

    const narrative =
      explainabilityModel.generateNarrative({
        summary,
        careerPathInsight,
        confidenceInsight,
      });

    // ═══════════════════════════════════════════════════════════════════
    // PREMIUM GATE
    // ═══════════════════════════════════════════════════════════════════

    const outputSkills = isPremium
      ? scoredSkills
      : scoredSkills.slice(
          0,
          config.freeUserSkillLimit
        );

    const result =
      this.returnStructuredResponse({
        summary,
        prioritizedSkills: outputSkills,
        careerPathInsight,
        confidenceInsight,
        narrative,
        isPremium,
        totalEvaluated:
          scoredSkills.length,
      });

    // ═══════════════════════════════════════════════════════════════════
    // OBSERVABILITY
    // ═══════════════════════════════════════════════════════════════════

    this._emitObservabilityLog({
      userId: profile.userId,
      targetRoleId:
        profile.targetRoleId,
      totalSkillsEvaluated:
        scoredSkills.length,
      highPrioritySkillsCount:
        summary.highPriorityCount,
      avgPriorityScore:
        summary.avgPriorityScore,
      estimatedSalaryDelta:
        summary.estimatedSalaryDelta,
      isPremium,
      durationMs:
        Date.now() - startTime,
    });

    return result;
  }

  // ═══════════════════════════════════════════════════════════════════
  // RESPONSE BUILDER
  // ═══════════════════════════════════════════════════════════════════

  returnStructuredResponse({
    summary,
    prioritizedSkills,
    careerPathInsight,
    confidenceInsight,
    narrative,
    isPremium,
    totalEvaluated,
  }) {
    return {
      meta: {
        engineVersion: "2.4",
        generatedAt:
          new Date().toISOString(),
        isPremiumView: isPremium,
        skillsReturned:
          prioritizedSkills.length,
        totalEvaluated,
      },
      summary,
      prioritizedSkills,
      careerPathInsight,
      confidenceInsight,
      narrative,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════════

  _buildSummary(scoredSkills) {
    const highPriority =
      scoredSkills.filter(
        (s) => s.priorityLevel === "HIGH"
      );

    const avgPriorityScore =
      scoredSkills.reduce(
        (sum, s) =>
          sum + s.priorityScore,
        0
      ) /
      (scoredSkills.length || 1);

    const estimatedSalaryDelta =
      parseFloat(
        scoredSkills.reduce(
          (sum, s) => {
            const realizationFactor =
              s.priorityScore / 100;
            return (
              sum +
              s.salaryImpactScore *
                realizationFactor
            );
          },
          0
        ).toFixed(2)
      );

    return {
      totalSkillsAnalyzed:
        scoredSkills.length,
      highPriorityCount:
        highPriority.length,
      avgPriorityScore:
        parseFloat(
          avgPriorityScore.toFixed(2)
        ),
      estimatedSalaryDelta,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════

  _classifyPriority(score) {
    const { high, medium } =
      config.priorityBands;
    if (score >= high.min)
      return "HIGH";
    if (score >= medium.min)
      return "MEDIUM";
    return "LOW";
  }

  _safeGet(
    dataMap,
    skillId,
    field,
    defaultValue
  ) {
    return (
      dataMap?.[skillId]?.[field] ??
      defaultValue
    );
  }

  _emitObservabilityLog(metrics) {
    logger.info(
      "[SkillPrioritization] Evaluation complete",
      {
        event:
          "skill_prioritization_complete",
        ...metrics,
      }
    );
  }
}

module.exports =
  SkillPrioritizationEngine;
