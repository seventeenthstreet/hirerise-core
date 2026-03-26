"use strict";

const path   = require('path');
const fs     = require('fs');
const config = require("../config/skillPriorityWeights");
const logger = require("../utils/logger");

const promotionModel      = require("./models/promotion.model");
const confidenceModel     = require("./models/confidence.model");
const synergyModel        = require("./models/synergy.model");
const explainabilityModel = require("../modules/explainability.model");
const learningModel       = require("./models/learning.model");

// ─── CSV dataset loader (in-memory cache) ─────────────────────────────────────

const DATA_DIR           = path.resolve(__dirname, '../data');
const SKILLS_DEMAND_FILE = path.join(DATA_DIR, 'skills-demand-india.csv');
const ROLE_SKILLS_FILE   = path.join(DATA_DIR, 'role-skills.csv');

let _csvCache = null;

function _loadCSVDatasets() {
  if (_csvCache) return _csvCache;

  function parseCSV(filePath) {
    if (!fs.existsSync(filePath)) return [];
    const lines   = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
    const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    return lines.slice(1).map(line => {
      // Handle quoted fields containing commas
      const fields = [];
      let cur = '', inQ = false;
      for (const ch of line) {
        if (ch === '"') { inQ = !inQ; }
        else if (ch === ',' && !inQ) { fields.push(cur.trim()); cur = ''; }
        else { cur += ch; }
      }
      fields.push(cur.trim());
      const row = {};
      headers.forEach((h, i) => { row[h] = (fields[i] || '').replace(/^"|"$/g, '').trim(); });
      return row;
    }).filter(r => Object.values(r).some(Boolean));
  }

  const skillRows = parseCSV(SKILLS_DEMAND_FILE);
  const roleRows  = parseCSV(ROLE_SKILLS_FILE);

  // Build skill demand map: normalised_name → record
  const skillDemandMap = {};
  for (const row of skillRows) {
    if (!row.skill) continue;
    const key = row.skill.toLowerCase().trim();
    skillDemandMap[key] = {
      skill:        row.skill,
      demand_score: parseFloat(row.demand_score) || 0,
      growth_rate:  parseFloat(row.growth_rate)  || 0,
      salary_boost: parseFloat(row.salary_boost) || 0,
      industry:     row.industry || 'General',
    };
  }

  // Build role-skills map: normalised_role → string[]
  const roleSkillsMap = {};
  for (const row of roleRows) {
    if (!row.role) continue;
    const skills = (row.skills || '').split(',').map(s => s.trim()).filter(Boolean);
    roleSkillsMap[row.role.toLowerCase().trim()] = skills;
  }

  _csvCache = { skillDemandMap, roleSkillsMap };
  return _csvCache;
}

class SkillPrioritizationEngine {
  constructor({
    roleSkillMatrixRepo,
    careerGraphRepo,
    skillMarketRepo,
    userRepo,
  }) {
    this._roleSkillMatrixRepo = roleSkillMatrixRepo;
    this._careerGraphRepo     = careerGraphRepo;
    this._skillMarketRepo     = skillMarketRepo;
    this._userRepo            = userRepo;
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
      user_id: profile.userId,
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
  // VALIDATE INPUT
  // Normalises the caller's input into a clean profile object.
  // ═══════════════════════════════════════════════════════════════════

  validateInput(input) {
    if (!input || typeof input !== 'object') {
      throw Object.assign(new Error('Input must be an object'), { statusCode: 422 });
    }

    const userId         = input.userId         || null;
    const experienceYears = Number(input.experienceYears) || 0;
    const resumeScore     = Number(input.resumeScore)    || 50;

    // Normalise role — accept display name (e.g. "Software Engineer") or role_id
    const targetRoleId  = this._normaliseRoleId(
      input.targetRoleId || input.targetRole || ''
    );
    const currentRoleId = this._normaliseRoleId(
      input.currentRoleId || input.currentRole || ''
    );

    // Normalise skills — accept string[] or {skillId, proficiencyLevel}[]
    const rawSkills = Array.isArray(input.skills) ? input.skills : [];
    const skills = rawSkills.map(s => {
      if (typeof s === 'string') {
        return {
          skillId:          this._normaliseSkillId(s),
          skillName:        s,
          proficiencyLevel: 50,
        };
      }
      return {
        skillId:          this._normaliseSkillId(s.skillId || s.name || ''),
        skillName:        s.skillName || s.name || s.skillId || '',
        proficiencyLevel: Number(s.proficiencyLevel || s.proficiency || 50),
      };
    }).filter(s => s.skillId);

    if (!targetRoleId) {
      throw Object.assign(
        new Error('targetRoleId or targetRole is required'),
        { statusCode: 422 }
      );
    }

    return {
      userId,
      targetRoleId,
      currentRoleId,
      experienceYears,
      resumeScore,
      skills,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // FETCH ROLE SKILL MATRIX
  // Returns the required skills for the target role.
  // Falls back to the existing repo, then to the CSV role-skills dataset.
  // ═══════════════════════════════════════════════════════════════════

  async fetchRoleSkillMatrix(targetRoleId, currentRoleId) {
    // 1. Try configured repo (may be a stub — returns null/undefined gracefully)
    if (this._roleSkillMatrixRepo?.getMatrix) {
      try {
        const matrix = await this._roleSkillMatrixRepo.getMatrix(targetRoleId);
        if (matrix && Object.keys(matrix).length > 0) return matrix;
      } catch (_) {}
    }

    // 2. Fall back to CSV role-skills dataset
    const { roleSkillsMap, skillDemandMap } = _loadCSVDatasets();
    const normRole = targetRoleId.replace(/_/g, ' ').toLowerCase();

    // Try exact match first, then partial match
    let required = roleSkillsMap[normRole];
    if (!required) {
      const key = Object.keys(roleSkillsMap).find(k =>
        k.includes(normRole) || normRole.includes(k)
      );
      required = key ? roleSkillsMap[key] : [];
    }

    // Build matrix: { skillId → { skillId, skillName, targetProficiency, skillType } }
    const matrix = {};
    for (const skillName of required) {
      const skillId = this._normaliseSkillId(skillName);
      const demandRec = skillDemandMap[skillName.toLowerCase().trim()];
      matrix[skillId] = {
        skillId,
        skillName,
        targetProficiency:  75,
        skillType:          demandRec ? 'CORE' : 'ADJACENT',
        demandScore:        demandRec?.demand_score || 50,
        growthRate:         demandRec?.growth_rate  || 0,
        salaryBoost:        demandRec?.salary_boost || 0,
      };
    }

    return matrix;
  }

  // ═══════════════════════════════════════════════════════════════════
  // FETCH MARKET DEMAND DATA
  // Returns a map: skillId → { demandScore, promotionBoost, cluster, futureTrend }
  // ═══════════════════════════════════════════════════════════════════

  async fetchMarketDemandData(targetRoleId) {
    // Try configured repo first
    if (this._skillMarketRepo?.getMarketData) {
      try {
        const data = await this._skillMarketRepo.getMarketData(targetRoleId);
        if (data && Object.keys(data).length > 0) return data;
      } catch (_) {}
    }

    // Fall back to CSV skills-demand-india.csv
    const { skillDemandMap } = _loadCSVDatasets();
    const result = {};

    for (const [normName, rec] of Object.entries(skillDemandMap)) {
      const skillId = this._normaliseSkillId(rec.skill);
      result[skillId] = {
        demandScore:    rec.demand_score,
        // promotionBoost: derived from salary_boost + demand_score
        promotionBoost: Math.round((rec.salary_boost * 0.5) + (rec.demand_score * 0.3)),
        // cluster: simple heuristic from demand level
        cluster: rec.demand_score >= 80 ? 'CORE'
               : rec.demand_score >= 60 ? 'ADJACENT'
               : rec.demand_score >= 40 ? 'TREND'
               : 'LEADERSHIP',
        // futureTrend: proxy from growth_rate
        futureTrend: Math.min(100, Math.round(rec.growth_rate * 2 + 40)),
      };
    }

    return result;
  }

  // ═══════════════════════════════════════════════════════════════════
  // FETCH SALARY IMPACT DATA
  // Returns a map: skillId → { salaryDelta }
  // ═══════════════════════════════════════════════════════════════════

  async fetchSalaryImpactData(targetRoleId) {
    const { skillDemandMap } = _loadCSVDatasets();
    const result = {};

    for (const [, rec] of Object.entries(skillDemandMap)) {
      const skillId = this._normaliseSkillId(rec.skill);
      result[skillId] = {
        // salary_boost is already 0-100 scale in the CSV
        salaryDelta: Math.min(100, Math.max(0, rec.salary_boost || 0)),
      };
    }

    return result;
  }

  // ═══════════════════════════════════════════════════════════════════
  // COMPUTE SKILL GAP
  // Compares user skills against role matrix to produce gap entries.
  // ═══════════════════════════════════════════════════════════════════

  computeSkillGap(userSkills, roleSkillMatrix) {
    const userSkillMap = {};
    for (const s of userSkills) {
      userSkillMap[s.skillId] = s.proficiencyLevel;
    }

    const gaps = [];

    for (const [skillId, roleSk] of Object.entries(roleSkillMatrix)) {
      const currentProf       = userSkillMap[skillId] ?? 0;
      const targetProf        = roleSk.targetProficiency ?? 75;
      const proficiencyGap    = Math.max(0, targetProf - currentProf);

      // Only include skills where there's a real gap
      if (proficiencyGap > 0) {
        gaps.push({
          skillId,
          skillName:           roleSk.skillName || skillId,
          currentProficiency:  currentProf,
          targetProficiency:   targetProf,
          proficiencyGap,
          skillType:           roleSk.skillType || 'CORE',
        });
      }
    }

    // Also include user skills not in role matrix but with high demand (market gaps)
    const { skillDemandMap } = _loadCSVDatasets();
    const matrixSkillIds     = new Set(Object.keys(roleSkillMatrix));

    for (const userSkill of userSkills) {
      if (matrixSkillIds.has(userSkill.skillId)) continue;
      const demandKey = userSkill.skillName?.toLowerCase().trim() || '';
      const demandRec = skillDemandMap[demandKey];
      if (demandRec && demandRec.demand_score >= 70 && userSkill.proficiencyLevel < 70) {
        gaps.push({
          skillId:            userSkill.skillId,
          skillName:          userSkill.skillName,
          currentProficiency: userSkill.proficiencyLevel,
          targetProficiency:  75,
          proficiencyGap:     75 - userSkill.proficiencyLevel,
          skillType:          'ADJACENT',
        });
      }
    }

    return gaps;
  }

  // ═══════════════════════════════════════════════════════════════════
  // RESOLVE SKILL DEPENDENCIES
  // Identifies which gap skills are "gateway" skills for career progression.
  // ═══════════════════════════════════════════════════════════════════

  async resolveSkillDependencies(skillIds, careerGraphData) {
    const dependencies    = {};
    const gatewaySkills   = new Set();
    const gatewayWeightMap = {};

    // If we have career graph data, use it to identify gateway skills
    if (careerGraphData?.requiredSkills?.length) {
      const requiredSet = new Set(
        careerGraphData.requiredSkills.map(s =>
          this._normaliseSkillId(s.skillId || s.name || s)
        )
      );
      for (const skillId of skillIds) {
        if (requiredSet.has(skillId)) {
          gatewaySkills.add(skillId);
          gatewayWeightMap[skillId] = 1 / requiredSet.size;
        }
        dependencies[skillId] = [];
      }
    } else {
      // Without career graph: treat top-demand skills as gateway
      const { skillDemandMap } = _loadCSVDatasets();
      for (const skillId of skillIds) {
        dependencies[skillId] = [];
        // Derive skill name from id (reverse slug)
        const skillName = skillId.replace(/_/g, ' ');
        const demandRec = skillDemandMap[skillName] || skillDemandMap[skillId];
        const demandScore = demandRec?.demand_score || 0;
        if (demandScore >= 80) {
          gatewaySkills.add(skillId);
          gatewayWeightMap[skillId] = 1;
        }
      }
    }

    const totalGatewayWeight = Object.values(gatewayWeightMap)
      .reduce((sum, w) => sum + w, 0);

    return {
      dependencies,
      gatewaySkills,
      gatewayWeightMap,
      totalGatewayWeight,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // APPLY PROFICIENCY OFFSET
  // Reduces score for skills already partially mastered (diminishing return).
  // ═══════════════════════════════════════════════════════════════════

  applyProficiencyOffset(score, currentProficiency) {
    if (currentProficiency >= config.highProficiencyThreshold) {
      // High proficiency — significant diminishing return
      const penalty = (currentProficiency - config.highProficiencyThreshold) / 100;
      return Math.max(0, score * (1 - penalty * config.proficiencyPenaltyWeight));
    }
    if (currentProficiency <= config.weakProficiencyThreshold) {
      // Very weak proficiency — slight urgency boost (foundational need)
      return Math.min(100, score * 1.05);
    }
    return score;
  }

  // ═══════════════════════════════════════════════════════════════════
  // CONTEXTUAL ADJUSTMENTS
  // ═══════════════════════════════════════════════════════════════════

  _applyContextualAdjustments(
    marketScore,
    skillType,
    cluster,
    experienceYears,
    resumeScore
  ) {
    let adjusted = marketScore;

    const exp = config.experience;

    // Junior users: boost CORE skills
    if (experienceYears <= exp.juniorMaxYears && skillType === 'CORE') {
      adjusted *= (1 + exp.juniorCoreBoost);
    }

    // Senior users: boost LEADERSHIP cluster
    if (experienceYears >= exp.seniorMinYears && cluster === 'LEADERSHIP') {
      adjusted *= (1 + exp.seniorLeadershipBoost);
    }

    // Low resume score: boost foundational skills
    if ((resumeScore || 50) < config.resumeScore.lowThreshold && skillType === 'CORE') {
      adjusted *= (1 + config.resumeScore.foundationalBoost);
    }

    return Math.min(100, adjusted);
  }

  // ═══════════════════════════════════════════════════════════════════
  // NORMALISATION HELPERS
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Convert display name or role_id to a normalised slug.
   * "Software Engineer" → "software_engineer"
   * "se_2"             → "se_2"  (already a slug)
   */
  _normaliseRoleId(raw) {
    if (!raw) return '';
    return raw.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
  }

  /**
   * Convert skill display name or id to a normalised slug.
   * "Machine Learning" → "machine_learning"
   */
  _normaliseSkillId(raw) {
    if (!raw) return '';
    return raw.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
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








