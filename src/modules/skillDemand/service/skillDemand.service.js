'use strict';

/**
 * skillDemand.service.js — Skill Demand Intelligence Service
 *
 * Supabase-native business logic for:
 * - role skill gap analysis
 * - demand-weighted recommendations
 * - score computation
 * - optional persistence
 */

const {
  loadDatasets,
  lookupSkillDemand,
  lookupRoleSkills,
  normalise,
} = require('../repository/skillDemandDataset');

const {
  SkillDemandRepository,
} = require('../repository/skillDemand.repository');

const logger = require('../../../utils/logger');

const MAX_RECOMMENDATIONS = 10;
const DEFAULT_TOP_DEMAND_LIMIT = 20;

class SkillDemandService {
  constructor(repository = new SkillDemandRepository()) {
    this.repo = repository;
  }

  /**
   * Analyze a user's skills against a target role.
   *
   * @param {Object} params
   * @param {string} params.role
   * @param {Array<string|{name:string}>} [params.skills]
   * @param {string|null} [params.userId]
   * @returns {Promise<Object>}
   */
  async analyzeSkillDemand({ role, skills = [], userId = null }) {
    if (!role || typeof role !== 'string') {
      throw new TypeError('role must be a non-empty string');
    }

    const { skillDemand: skillDemandMap, roleSkills: roleSkillsMap } =
      await loadDatasets();

    const requiredSkills = lookupRoleSkills(roleSkillsMap, role);

    const normalizedUserSkillSet = new Set();
    const originalUserSkills = [];

    for (const entry of skills) {
      const rawSkill =
        typeof entry === 'string'
          ? entry
          : typeof entry?.name === 'string'
            ? entry.name
            : '';

      if (!rawSkill) continue;

      originalUserSkills.push(rawSkill);

      const normalized = normalise(rawSkill);
      if (normalized) {
        normalizedUserSkillSet.add(normalized);
      }
    }

    const skillGaps = [];
    const matchedSkills = [];

    for (const requiredSkill of requiredSkills) {
      const normalizedRequired = normalise(requiredSkill);

      let matched = false;

      for (const userSkill of normalizedUserSkillSet) {
        if (
          userSkill === normalizedRequired ||
          userSkill.includes(normalizedRequired) ||
          normalizedRequired.includes(userSkill)
        ) {
          matched = true;
          break;
        }
      }

      if (matched) {
        matchedSkills.push(requiredSkill);
      } else {
        skillGaps.push(requiredSkill);
      }
    }

    const skillScore = requiredSkills.length
      ? Math.round((matchedSkills.length / requiredSkills.length) * 100)
      : 0;

    const topRecommendedSkills = skillGaps
      .map((skill) => {
        const demand = lookupSkillDemand(skillDemandMap, skill);

        return {
          skill,
          demand_score: demand?.demand_score ?? 0,
          growth_rate: demand?.growth_rate ?? 0,
          salary_boost: demand?.salary_boost ?? 0,
          industry: demand?.industry ?? 'General',
        };
      })
      .sort((a, b) => b.demand_score - a.demand_score)
      .slice(0, MAX_RECOMMENDATIONS);

    const result = {
      role,
      skill_score: skillScore,
      user_skills: originalUserSkills,
      required_skills: requiredSkills,
      skill_gaps: skillGaps,
      top_recommended_skills: topRecommendedSkills,
    };

    if (userId) {
      void this.repo.saveAnalysis(userId, result).catch((error) => {
        logger.warn('[SkillDemandService] Persist failed', {
          userId,
          role,
          error: error.message,
        });
      });
    }

    logger.info('[SkillDemandService] Analysis complete', {
      role,
      skillScore,
      requiredSkillCount: requiredSkills.length,
      gapCount: skillGaps.length,
    });

    return result;
  }

  /**
   * Lightweight adapter for CHI engine.
   *
   * @param {string} role
   * @param {Array<string|{name:string}>} skills
   * @returns {Promise<number>}
   */
  async computeChiSkillScore(role, skills) {
    const result = await this.analyzeSkillDemand({ role, skills });
    return result.skill_score;
  }

  /**
   * Return highest-demand skills globally or by industry.
   *
   * @param {Object} [options]
   * @param {string} [options.industry]
   * @param {number} [options.limit]
   * @returns {Promise<Object[]>}
   */
  async getTopDemandSkills({
    industry,
    limit = DEFAULT_TOP_DEMAND_LIMIT,
  } = {}) {
    const { skillDemand: skillDemandMap } = await loadDatasets();

    let skills = Array.from(skillDemandMap.values());

    if (industry) {
      const normalizedIndustry = industry.toLowerCase().trim();

      skills = skills.filter(
        (item) =>
          item.industry?.toLowerCase().trim() === normalizedIndustry
      );
    }

    skills.sort((a, b) => b.demand_score - a.demand_score);

    return skills.slice(0, limit);
  }

  /**
   * Return required skills for a role.
   *
   * @param {string} role
   * @returns {Promise<string[]>}
   */
  async getRequiredSkillsForRole(role) {
    const { roleSkills: roleSkillsMap } = await loadDatasets();
    return lookupRoleSkills(roleSkillsMap, role);
  }

  /**
   * Return saved user analysis history.
   *
   * @param {string} userId
   * @returns {Promise<Object[]>}
   */
  async getUserAnalysisHistory(userId) {
    return this.repo.listUserAnalyses(userId);
  }
}

module.exports = { SkillDemandService };