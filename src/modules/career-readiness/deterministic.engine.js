const config = require("../../config/careerReadiness.weights");

class DeterministicEngine {
  constructor({
    salaryService,
    skillIntelligenceService,
    resumeScoreService,
    careerRoleGraph,
  }) {
    this.salaryService = salaryService;
    this.skillIntelligenceService = skillIntelligenceService;
    this.resumeScoreService = resumeScoreService;
    this.careerRoleGraph = careerRoleGraph;
  }

  /**
   * MAIN DETERMINISTIC COMPUTE
   */
  async compute(candidateProfile, resumeData) {
    const roleMetadata = await this.careerRoleGraph.getRoleById(
      candidateProfile.targetRoleId
    );

    const salaryBenchmark =
      await this.salaryService.getBenchmark(candidateProfile.targetRoleId);

    const resumeScore =
      await this.resumeScoreService.getScore(candidateProfile.candidateId);

    const skillDemandData =
      await this.skillIntelligenceService.getSkillDemand(
        candidateProfile.skills
      );

    // ──────────────────────────────────────────────
    // NORMALIZE RESUME SCORE TO 0–1
    // ──────────────────────────────────────────────
    let normalizedResumeScore;

    if (resumeScore?.normalized <= 1) {
      normalizedResumeScore = resumeScore.normalized;
    } else {
      normalizedResumeScore = resumeScore.normalized / 100;
    }

    normalizedResumeScore = this._clamp01(normalizedResumeScore);

    // ──────────────────────────────────────────────
    // CALCULATE DIMENSIONS (ALL 0–1 SCALE)
    // ──────────────────────────────────────────────

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

    // Validate all normalized scores
    this._assertNormalized(skillMatch.score, "skillMatch");
    this._assertNormalized(experienceAlignment.score, "experienceAlignment");
    this._assertNormalized(salaryPositioning.score, "salaryPositioning");
    this._assertNormalized(marketDemand.score, "marketDemandAlignment");
    this._assertNormalized(normalizedResumeScore, "resumeStrength");

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

  // ──────────────────────────────────────────────
  // SKILL MATCH
  // ──────────────────────────────────────────────
  _computeSkillMatch(candidateSkills, coreSkills, secondarySkills = []) {
    const { SKILL_MATCH } = config;

    const coreSet = new Set(coreSkills.map((s) => s.toLowerCase()));
    const secSet = new Set(secondarySkills.map((s) => s.toLowerCase()));
    const candidateSet = new Set(
      candidateSkills.map((s) => s.toLowerCase())
    );

    const coreMatched = [...coreSet].filter((s) => candidateSet.has(s));
    const secMatched = [...secSet].filter((s) => candidateSet.has(s));

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
      missingCoreSkills: [...coreSet].filter((s) => !candidateSet.has(s)),
      missingSecondarySkills: [...secSet].filter(
        (s) => !candidateSet.has(s)
      ),
      matchedCoreSkills: coreMatched,
    };
  }

  // ──────────────────────────────────────────────
  // EXPERIENCE ALIGNMENT
  // ──────────────────────────────────────────────
  _computeExperienceAlignment(candidateYears, requiredYears) {
    const { EXPERIENCE } = config;

    const delta = candidateYears - requiredYears;
    let score;

    if (delta >= 0) {
      score =
        EXPERIENCE.yearsFullMatchThreshold +
        Math.min(delta * EXPERIENCE.bonusPerYearOver, EXPERIENCE.overflowCap);
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

  // ──────────────────────────────────────────────
  // SALARY POSITIONING
  // ──────────────────────────────────────────────
  _computeSalaryPositioning(currentSalary, benchmark) {
    const { p25, p50, p75 } = benchmark;

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

  // ──────────────────────────────────────────────
  // MARKET DEMAND ALIGNMENT
  // ──────────────────────────────────────────────
  _computeMarketDemand(candidateSkills, skillDemandData) {
    const { MARKET_DEMAND } = config;

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

  _computeCertificationMatch(candidateCerts, preferredCerts = []) {
    if (preferredCerts.length === 0)
      return { score: 1.0, matched: [], missing: [] };

    const prefSet = new Set(
      preferredCerts.map((c) => c.toLowerCase())
    );

    const matched = candidateCerts.filter((c) =>
      prefSet.has(c.toLowerCase())
    );

    return {
      score: this._clamp01(matched.length / preferredCerts.length),
      matched,
      missing: [...prefSet].filter(
        (c) => !candidateCerts.map((x) => x.toLowerCase()).includes(c)
      ),
    };
  }

  _computeEducationAlignment(candidateEdu, minimumEdu) {
    const levels = { none: 0, associates: 1, bachelors: 2, masters: 3, phd: 4 };

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

  // ──────────────────────────────────────────────
  // UTILITIES
  // ──────────────────────────────────────────────
  _clamp01(value) {
    return Math.min(1, Math.max(0, value));
  }

  _assertNormalized(value, name) {
    if (value < 0 || value > 1) {
      throw new Error(`${name} score must be between 0 and 1`);
    }
  }
}

module.exports = DeterministicEngine;









