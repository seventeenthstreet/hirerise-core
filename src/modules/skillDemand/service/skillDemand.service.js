'use strict';

/**
 * skillDemand.service.js — Skill Demand Intelligence Service
 *
 * Core business logic for skill demand analysis.
 * Compares user skills against role-required skills using the CSV dataset
 * and produces a scored result with gap analysis and recommendations.
 *
 * @module modules/skillDemand/service/skillDemand.service
 */

const { loadDatasets, lookupSkillDemand, lookupRoleSkills, normalise } = require('../repository/skillDemandDataset');
const { SkillDemandRepository } = require('../repository/skillDemand.repository');
const logger = require('../../../utils/logger');

/**
 * @typedef {Object} SkillDemandResult
 * @property {string}   role
 * @property {number}   skill_score               — 0–100 composite score
 * @property {string[]} user_skills               — normalised user skill list
 * @property {string[]} required_skills           — skills required for the role
 * @property {string[]} skill_gaps                — required skills the user lacks
 * @property {Object[]} top_recommended_skills    — top gap skills sorted by demand
 */

class SkillDemandService {
  constructor() {
    this.repo = new SkillDemandRepository();
  }

  /**
   * Full skill demand analysis for a user vs a role.
   * Persists result to Firestore when userId is provided.
   *
   * @param {Object}   params
   * @param {string}   params.role
   * @param {string[]} params.skills        — user's current skills
   * @param {string}   [params.userId]      — if provided, result is persisted
   * @returns {Promise<SkillDemandResult>}
   */
  async analyzeSkillDemand({ role, skills = [], userId }) {
    const { skillDemand: skillDemandMap, roleSkills: roleSkillsMap } = await loadDatasets();

    const requiredSkills = lookupRoleSkills(roleSkillsMap, role);
    const normUserSkills = skills.map(s => normalise(typeof s === 'string' ? s : s.name || ''));

    // Identify gaps
    const skillGaps = requiredSkills.filter(req => {
      const normReq = normalise(req);
      return !normUserSkills.some(u => u === normReq || u.includes(normReq) || normReq.includes(u));
    });

    // Score matched skills
    const matchedSkills = requiredSkills.filter(req => !skillGaps.includes(req));
    const skillScore = requiredSkills.length > 0
      ? Math.round((matchedSkills.length / requiredSkills.length) * 100)
      : 0;

    // Rank gap skills by demand data
    const topRecommendedSkills = skillGaps
      .map(skill => {
        const demand = lookupSkillDemand(skillDemandMap, skill);
        return {
          skill,
          demand_score:  demand?.demand_score  ?? 0,
          growth_rate:   demand?.growth_rate   ?? 0,
          salary_boost:  demand?.salary_boost  ?? 0,
          industry:      demand?.industry      ?? 'General',
        };
      })
      .sort((a, b) => b.demand_score - a.demand_score)
      .slice(0, 10);

    const result = {
      role,
      skill_score:            skillScore,
      user_skills:            skills.map(s => typeof s === 'string' ? s : s.name || ''),
      required_skills:        requiredSkills,
      skill_gaps:             skillGaps,
      top_recommended_skills: topRecommendedSkills,
    };

    if (userId) {
      try {
        await this.repo.saveAnalysis(userId, result);
      } catch (err) {
        logger.warn('[SkillDemandService] Failed to persist analysis', { userId, role, err: err.message });
      }
    }

    logger.info('[SkillDemandService] Analysis complete', { role, skillScore, gaps: skillGaps.length });
    return result;
  }

  /**
   * Lightweight adapter for CHI engine — returns only the numeric score.
   *
   * @param {string}   role
   * @param {string[]} skills
   * @returns {Promise<number>} 0–100
   */
  async computeChiSkillScore(role, skills) {
    const { skill_score } = await this.analyzeSkillDemand({ role, skills });
    return skill_score;
  }

  /**
   * Return top-demand skills for a given industry (or all industries).
   *
   * @param {Object} [options]
   * @param {string} [options.industry]
   * @param {number} [options.limit=20]
   * @returns {Promise<Object[]>}
   */
  async getTopDemandSkills({ industry, limit = 20 } = {}) {
    const { skillDemand: skillDemandMap } = await loadDatasets();

    let skills = Array.from(skillDemandMap.values());

    if (industry) {
      const normIndustry = industry.toLowerCase().trim();
      skills = skills.filter(s => s.industry?.toLowerCase().trim() === normIndustry);
    }

    return skills
      .sort((a, b) => b.demand_score - a.demand_score)
      .slice(0, limit);
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
   * Return analysis history for a user.
   *
   * @param {string} userId
   * @returns {Promise<Object[]>}
   */
  async getUserAnalysisHistory(userId) {
    return this.repo.listUserAnalyses(userId);
  }
}

module.exports = { SkillDemandService };









