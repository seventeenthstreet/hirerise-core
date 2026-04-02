"use strict";

/**
 * src/modules/career-readiness/deterministic.engine.js
 *
 * Production-grade deterministic scoring engine
 * - Firebase clean
 * - Supabase analytics safe
 * - crash-resistant dependency handling
 * - stable normalized scoring
 */

const config = require("../../config/careerReadiness.weights");
const logger = require("../../utils/logger");

class DeterministicEngine {
  constructor({
    salaryService,
    skillIntelligenceService,
    resumeScoreService,
    careerRoleGraph,
  }) {
    if (!salaryService) {
      throw new Error("[DeterministicEngine] Missing salaryService");
    }

    if (!resumeScoreService) {
      throw new Error("[DeterministicEngine] Missing resumeScoreService");
    }

    this.salaryService = salaryService;
    this.skillIntelligenceService = skillIntelligenceService ?? {};
    this.resumeScoreService = resumeScoreService;
    this.careerRoleGraph = careerRoleGraph ?? {};
  }

  /**
   * Main deterministic compute
   */
  async compute(candidateProfile, resumeData) {
    const roleMetadata = await this._getRoleMetadata(
      candidateProfile.targetRoleId
    );

    const salaryBenchmark =
      (await this.salaryService.getBenchmark(
        candidateProfile.targetRoleId
      )) ?? {
        p25: 0,
        p50: candidateProfile.currentSalary || 1,
        p75: candidateProfile.currentSalary || 1,
      };

    const resumeScore =
      (await this.resumeScoreService.getScore(
        candidateProfile.candidateId,
        resumeData
      )) ?? { normalized: 0.5 };

    const skillDemandData =
      (await this._getSkillDemand(candidateProfile.skills)) ?? {};

    let normalizedResumeScore =
      Number(resumeScore?.normalized ?? 0.5);

    if (normalizedResumeScore > 1) {
      normalizedResumeScore /= 100;
    }

    normalizedResumeScore = this._clamp01(normalizedResumeScore);

    const skillMatch = this._computeSkillMatch(
      candidateProfile.skills,
      roleMetadata.requiredSkills,
      roleMetadata.secondarySkills
    );

    const experienceAlignment = this._computeExperienceAlignment(
      candidateProfile.totalYearsExperience,
      roleMetadata.requiredYears
    );

    const salaryPositioning = this._computeSalaryPositioning(
      candidateProfile.currentSalary,
      salaryBenchmark
    );

    const marketDemand = this._computeMarketDemand(
      candidateProfile.skills,
      skillDemandData
    );

    const certificationMatch = this._computeCertificationMatch(
      candidateProfile.certifications,
      roleMetadata.preferredCertifications
    );

    const educationAlignment = this._computeEducationAlignment(
      candidateProfile.highestEducation,
      roleMetadata.minimumEducation
    );

    this._assertNormalized(skillMatch.score, "skillMatch");
    this._assertNormalized(
      experienceAlignment.score,
      "experienceAlignment"
    );
    this._assertNormalized(
      salaryPositioning.score,
      "salaryPositioning"
    );
    this._assertNormalized(
      marketDemand.score,
      "marketDemandAlignment"
    );
    this._assertNormalized(
      normalizedResumeScore,
      "resumeStrength"
    );

    return {
      scores: {
        skillMatch: skillMatch.score,
        experienceAlignment: experienceAlignment.score,
        salaryPositioning: salaryPositioning.score,
        marketDemandAlignment: marketDemand.score,
        resumeStrength: normalizedResumeScore,
      },
      meta: {
        roleMetadata,
        salaryBenchmark,
        resumeScore,
        skillDemandData,
        skillMatch,
        experienceAlignment,
        salaryPositioning,
        marketDemand,
        certificationMatch,
        educationAlignment,
      },
    };
  }

  async _getRoleMetadata(roleId) {
    try {
      if (typeof this.careerRoleGraph.getRoleById === "function") {
        return (
          (await this.careerRoleGraph.getRoleById(roleId)) ??
          this._emptyRoleMetadata()
        );
      }

      if (typeof this.careerRoleGraph === "object") {
        return this.careerRoleGraph[roleId] ?? this._emptyRoleMetadata();
      }

      return this._emptyRoleMetadata();
    } catch (error) {
      logger.warn("[DeterministicEngine] Role metadata fallback", {
        error: error?.message ?? "Unknown role graph error",
        roleId,
      });
      return this._emptyRoleMetadata();
    }
  }

  async _getSkillDemand(skills) {
    if (
      typeof this.skillIntelligenceService.getSkillDemand === "function"
    ) {
      return this.skillIntelligenceService.getSkillDemand(skills);
    }

    if (
      typeof this.skillIntelligenceService.computeGapAnalysis ===
      "function"
    ) {
      return {};
    }

    return {};
  }

  _emptyRoleMetadata() {
    return {
      requiredSkills: [],
      secondarySkills: [],
      requiredYears: 0,
      preferredCertifications: [],
      minimumEducation: "none",
    };
  }

  _computeSkillMatch(candidateSkills, coreSkills = [], secondarySkills = []) {
    const { SKILL_MATCH } = config;

    const coreSet = new Set(coreSkills.map((s) => s.toLowerCase()));
    const secSet = new Set(secondarySkills.map((s) => s.toLowerCase()));
    const candidateSet = new Set(
      (candidateSkills ?? []).map((s) => s.toLowerCase())
    );

    const coreMatched = [...coreSet].filter((s) =>
      candidateSet.has(s)
    );

    const secMatched = [...secSet].filter((s) =>
      candidateSet.has(s)
    );

    const coreRatio =
      coreSet.size > 0 ? coreMatched.length / coreSet.size : 1;

    const secRatio =
      secSet.size > 0 ? secMatched.length / secSet.size : 1;

    const score =
      coreRatio * SKILL_MATCH.coreSkillWeight +
      secRatio * SKILL_MATCH.secondarySkillWeight;

    return {
      score: this._clamp01(score),
      coreMatchRatio: coreRatio,
      secondaryMatchRatio: secRatio,
      missingCoreSkills: [...coreSet].filter(
        (s) => !candidateSet.has(s)
      ),
      missingSecondarySkills: [...secSet].filter(
        (s) => !candidateSet.has(s)
      ),
      matchedCoreSkills: coreMatched,
    };
  }

  _computeExperienceAlignment(candidateYears, requiredYears = 0) {
    const { EXPERIENCE } = config;

    const delta = candidateYears - requiredYears;
    let score;

    if (delta >= 0) {
      score =
        EXPERIENCE.yearsFullMatchThreshold +
        Math.min(
          delta * EXPERIENCE.bonusPerYearOver,
          EXPERIENCE.overflowCap
        );
    } else {
      score =
        EXPERIENCE.yearsFullMatchThreshold +
        delta * EXPERIENCE.penaltyPerYearShort;
    }

    return {
      score: this._clamp01(score),
      candidateYears,
      requiredYears,
      delta,
    };
  }

  _computeSalaryPositioning(currentSalary, benchmark = {}) {
    const p25 = benchmark.p25 ?? 0;
    const p50 = benchmark.p50 ?? Math.max(currentSalary || 1, 1);
    const p75 = benchmark.p75 ?? p50;

    const ratio = currentSalary / p50;
    const score = Math.min(1, ratio / 1.5);

    let positioning;
    if (currentSalary < p25) positioning = "significantly_below";
    else if (currentSalary < p50) positioning = "below_median";
    else if (currentSalary <= p75) positioning = "at_or_above_median";
    else positioning = "above_market";

    return {
      score: this._clamp01(score),
      ratio,
      positioning,
    };
  }

  _computeMarketDemand(candidateSkills = [], skillDemandData = {}) {
    const { MARKET_DEMAND } = config;

    if (!candidateSkills.length) {
      return {
        score: 0,
        avgDemandPercentile: 0,
      };
    }

    const percentiles = candidateSkills.map((skill) => {
      const data = skillDemandData[skill.toLowerCase()];
      return data ? data.demandPercentile : 50;
    });

    const avg =
      percentiles.reduce((a, b) => a + b, 0) / percentiles.length;

    let score = avg / 100;

    if (avg < MARKET_DEMAND.highDemandThreshold) {
      score *= MARKET_DEMAND.lowDemandPenalty;
    }

    return {
      score: this._clamp01(score),
      avgDemandPercentile: avg,
    };
  }

  _computeCertificationMatch(candidateCerts = [], preferredCerts = []) {
    if (!preferredCerts.length) {
      return { score: 1, matched: [], missing: [] };
    }

    const prefSet = new Set(
      preferredCerts.map((c) => c.toLowerCase())
    );

    const normalizedCandidate = candidateCerts.map((c) =>
      c.toLowerCase()
    );

    const matched = normalizedCandidate.filter((c) =>
      prefSet.has(c)
    );

    return {
      score: this._clamp01(matched.length / preferredCerts.length),
      matched,
      missing: [...prefSet].filter(
        (c) => !normalizedCandidate.includes(c)
      ),
    };
  }

  _computeEducationAlignment(candidateEdu, minimumEdu) {
    const levels = {
      none: 0,
      associates: 1,
      bachelors: 2,
      masters: 3,
      phd: 4,
    };

    const candidateLevel = levels[candidateEdu] ?? 0;
    const requiredLevel = levels[minimumEdu] ?? 0;

    const score =
      candidateLevel >= requiredLevel
        ? 1
        : Math.max(0, 1 - (requiredLevel - candidateLevel) * 0.25);

    return {
      score: this._clamp01(score),
      candidateEdu,
      minimumEdu,
    };
  }

  _clamp01(value) {
    return Math.min(1, Math.max(0, Number(value) || 0));
  }

  _assertNormalized(value, name) {
    if (value < 0 || value > 1 || Number.isNaN(value)) {
      throw new Error(`${name} score must be between 0 and 1`);
    }
  }
}

module.exports = DeterministicEngine;