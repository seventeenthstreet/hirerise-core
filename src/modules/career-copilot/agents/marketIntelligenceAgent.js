'use strict';

/**
 * src/modules/career-copilot/agents/marketIntelligenceAgent.js
 *
 * Labor market intelligence orchestration agent.
 * Optimized for:
 * - partial upstream failures
 * - deterministic formatting
 * - token-efficient downstream advisor prompts
 */

const BaseAgent = require('./baseAgent');
const logger = require('../../../utils/logger');

const marketTrendService = safeRequire(
  '../../../modules/labor-market-intelligence/services/marketTrend.service',
  'MarketTrendService'
);

/**
 * INR formatter with safe numeric coercion.
 *
 * @param {number|string|null} amount
 * @returns {string|null}
 */
function formatINR(amount) {
  const numeric = Number(amount);

  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  if (numeric >= 100000) {
    return `₹${(numeric / 100000).toFixed(1)}L`;
  }

  return `₹${numeric.toLocaleString('en-IN')}`;
}

class MarketIntelligenceAgent extends BaseAgent {
  get agentName() {
    return 'MarketIntelligenceAgent';
  }

  get cachePrefix() {
    return 'agent:market';
  }

  /**
   * @param {string} userId
   * @param {object} context
   * @returns {Promise<object>}
   */
  async run(userId, context = {}) {
    if (!marketTrendService) {
      throw new Error('MarketTrendService unavailable');
    }

    const [careerTrends, skillDemand, salaryBenchmarksRaw] =
      await this._fetchMarketData();

    const trendingSkills = this._buildTrendingSkills(skillDemand);
    const careerDemand = this._buildCareerDemand(careerTrends);
    const salaryBenchmarks =
      this._buildSalaryBenchmarks(salaryBenchmarksRaw);

    const targetRoleSalary = this._findTargetRoleSalary(
      salaryBenchmarksRaw,
      context?.target_role
    );

    const marketInsights = this._buildMarketInsights({
      trendingSkills,
      careerDemand,
      targetRoleSalary,
    });

    logger.info('[MarketIntelligenceAgent] Done', {
      userId,
      skills: trendingSkills.length,
      careers: careerDemand.length,
      salaries: salaryBenchmarks.length,
    });

    return {
      trending_skills: trendingSkills,
      career_demand: careerDemand,
      salary_benchmarks: salaryBenchmarks,
      target_role_salary: targetRoleSalary,
      market_insights: marketInsights,
    };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Data fetch
  // ────────────────────────────────────────────────────────────────────────────

  async _fetchMarketData() {
    const [trendsRes, skillsRes, salaryRes] =
      await Promise.allSettled([
        marketTrendService.getCareerTrends(),
        marketTrendService.getSkillDemand(20),
        marketTrendService.getSalaryBenchmarks(),
      ]);

    return [
      trendsRes.status === 'fulfilled' && Array.isArray(trendsRes.value)
        ? trendsRes.value
        : [],
      skillsRes.status === 'fulfilled' && Array.isArray(skillsRes.value)
        ? skillsRes.value
        : [],
      salaryRes.status === 'fulfilled' && Array.isArray(salaryRes.value)
        ? salaryRes.value
        : [],
    ];
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Builders
  // ────────────────────────────────────────────────────────────────────────────

  _buildTrendingSkills(rawSkills = []) {
    return [...rawSkills]
      .sort(
        (a, b) =>
          Number(b?.demand_score || 0) -
          Number(a?.demand_score || 0)
      )
      .slice(0, 12)
      .map((skill) => ({
        skill: skill?.skill_name || skill?.name || null,
        demand_score: this._safeScore(skill?.demand_score),
        growth_rate: Number(skill?.growth_rate || 0),
        salary_boost: Number(skill?.salary_boost || 0),
        industry: Array.isArray(skill?.industry_usage)
          ? skill.industry_usage.join(', ')
          : 'General',
      }))
      .filter((skill) => skill.skill);
  }

  _buildCareerDemand(rawTrends = []) {
    return [...rawTrends]
      .sort((a, b) => {
        const scoreB = Number(
          b?.trend_score ?? b?.demand_score ?? 0
        );
        const scoreA = Number(
          a?.trend_score ?? a?.demand_score ?? 0
        );
        return scoreB - scoreA;
      })
      .slice(0, 8)
      .map((trend) => ({
        career:
          trend?.career_name ||
          trend?.career ||
          trend?.role_name ||
          null,
        trend_score: this._safeScore(
          trend?.trend_score ?? trend?.demand_score
        ),
        growth_rate: Number(trend?.growth_rate || 0),
      }))
      .filter((career) => career.career);
  }

  _buildSalaryBenchmarks(rawSalaries = []) {
    return rawSalaries.slice(0, 8).map((salary) => ({
      career: salary?.career_name || salary?.career || null,
      entry_salary: formatINR(salary?.avg_entry_salary),
      mid_salary: formatINR(salary?.avg_5yr_salary),
      senior_salary: formatINR(salary?.avg_10yr_salary),
      salary_growth_pct:
        salary?.salary_growth != null
          ? `${Math.round(Number(salary.salary_growth) * 100)}%/yr`
          : null,
    }));
  }

  _findTargetRoleSalary(rawSalaries = [], targetRole) {
    if (!targetRole || !Array.isArray(rawSalaries)) {
      return null;
    }

    const normalized = String(targetRole).toLowerCase().trim();
    if (!normalized) return null;

    const keywords = normalized.split(/\s+/).slice(0, 2);

    const match = rawSalaries.find((salary) => {
      const careerName = String(
        salary?.career_name || salary?.career || ''
      ).toLowerCase();

      return keywords.some((keyword) => careerName.includes(keyword));
    });

    if (!match) return null;

    return {
      career: match?.career_name || match?.career || null,
      entry_salary: formatINR(match?.avg_entry_salary),
      mid_salary: formatINR(match?.avg_5yr_salary),
      senior_salary: formatINR(match?.avg_10yr_salary),
    };
  }

  _buildMarketInsights({
    trendingSkills = [],
    careerDemand = [],
    targetRoleSalary = null,
  }) {
    const topSkill = trendingSkills[0];
    const topCareer = careerDemand[0];

    return [
      topSkill
        ? `${topSkill.skill} is currently the most in-demand skill (${topSkill.demand_score}/100).`
        : null,
      topCareer
        ? `${topCareer.career} currently leads career demand growth.`
        : null,
      targetRoleSalary
        ? `${targetRoleSalary.career} salary ranges from ${targetRoleSalary.entry_salary} to ${targetRoleSalary.senior_salary}.`
        : null,
    ].filter(Boolean);
  }

  _safeScore(value) {
    const numeric = Number(value || 0);
    return Math.max(0, Math.min(100, Math.round(numeric)));
  }
}

/**
 * Safe singleton require at module load.
 */
function safeRequire(path, name) {
  try {
    return require(path);
  } catch (err) {
    logger.warn(`[MarketIntelligenceAgent] ${name} unavailable`, {
      error: err instanceof Error ? err.message : 'Unknown require error',
    });
    return null;
  }
}

module.exports = MarketIntelligenceAgent;