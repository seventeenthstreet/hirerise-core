'use strict';

/**
 * marketIntelligenceAgent.js — Market Intelligence Agent
 *
 * Uses: Labor Market Intelligence Engine
 *
 * Calls (read-only, never modified):
 *   marketTrendService.getCareerTrends()        → career demand scores + growth rates
 *   marketTrendService.getSkillDemand(limit)    → top in-demand skills with demand_score
 *   marketTrendService.getSalaryBenchmarks()    → salary bands per career
 *
 * Output:
 *   trending_skills      — top skills by demand_score
 *   career_demand        — top careers by demand + growth
 *   salary_benchmarks    — salary ranges per career (INR)
 *   target_role_salary   — salary specifically for user's target role
 *   market_insights      — 2-3 key market sentences for the advisor prompt
 *
 * File location: src/modules/career-copilot/agents/marketIntelligenceAgent.js
 *
 * @module src/modules/career-copilot/agents/marketIntelligenceAgent
 */

const BaseAgent = require('./baseAgent');
const logger    = require('../../../utils/logger');

// ─── Salary formatter ─────────────────────────────────────────────────────────

function _formatINR(amount) {
  if (!amount || isNaN(amount)) return null;
  if (amount >= 100000) return `₹${(amount / 100000).toFixed(1)}L`;
  return `₹${amount.toLocaleString('en-IN')}`;
}

class MarketIntelligenceAgent extends BaseAgent {

  get agentName()   { return 'MarketIntelligenceAgent'; }
  get cachePrefix() { return 'agent:market'; }

  async run(userId, context) {
    const marketSvc = this._require(
      '../../../modules/labor-market-intelligence/services/marketTrend.service',
      'MarketTrendService'
    );
    if (!marketSvc) throw new Error('MarketTrendService unavailable');

    // ── Fetch all market data in parallel ─────────────────────────────────────
    const [trendsRes, skillDemandRes, salaryRes] = await Promise.allSettled([
      marketSvc.getCareerTrends(),
      marketSvc.getSkillDemand(20),
      marketSvc.getSalaryBenchmarks(),
    ]);

    const rawTrends    = trendsRes.status      === 'fulfilled' ? (trendsRes.value      || []) : [];
    const rawSkills    = skillDemandRes.status === 'fulfilled' ? (skillDemandRes.value || []) : [];
    const rawSalaries  = salaryRes.status      === 'fulfilled' ? (salaryRes.value      || []) : [];

    // ── Trending skills ───────────────────────────────────────────────────────
    const trendingSkills = [...rawSkills]
      .sort((a, b) => (b.demand_score || 0) - (a.demand_score || 0))
      .slice(0, 12)
      .map(s => ({
        skill:        s.skill_name || s.name,
        demand_score: Math.round(s.demand_score  || 0),
        growth_rate:  s.growth_rate              || 0,
        salary_boost: s.salary_boost             || 0,
        industry:     (s.industry_usage || []).join(', ') || 'General',
      }));

    // ── Career demand ─────────────────────────────────────────────────────────
    const careerDemand = [...rawTrends]
      .sort((a, b) => (b.trend_score || b.demand_score || 0) - (a.trend_score || a.demand_score || 0))
      .slice(0, 8)
      .map(t => ({
        career:      t.career_name || t.career || t.role_name,
        trend_score: Math.round(t.trend_score  || t.demand_score || 0),
        growth_rate: t.growth_rate             || 0,
      }));

    // ── Salary benchmarks ─────────────────────────────────────────────────────
    const salaryBenchmarks = rawSalaries.slice(0, 8).map(s => ({
      career:           s.career_name || s.career,
      entry_salary:     _formatINR(s.avg_entry_salary),
      mid_salary:       _formatINR(s.avg_5yr_salary),
      senior_salary:    _formatINR(s.avg_10yr_salary),
      salary_growth_pct: s.salary_growth
        ? `${Math.round(s.salary_growth * 100)}%/yr`
        : null,
    }));

    // ── Target role salary lookup ─────────────────────────────────────────────
    const targetRole = context?.target_role || null;
    let targetRoleSalary = null;

    if (targetRole) {
      const keyword = targetRole.toLowerCase().split(' ')[0];
      const match   = rawSalaries.find(s =>
        (s.career_name || s.career || '').toLowerCase().includes(keyword)
      );
      if (match) {
        targetRoleSalary = {
          career:       match.career_name || match.career,
          entry_salary: _formatINR(match.avg_entry_salary),
          mid_salary:   _formatINR(match.avg_5yr_salary),
          senior_salary: _formatINR(match.avg_10yr_salary),
        };
      }
    }

    // ── Market insights (for advisor prompt context) ──────────────────────────
    const topSkillName = trendingSkills[0]?.skill || 'technical skills';
    const topCareer    = careerDemand[0]?.career  || null;
    const insights     = [
      `${topSkillName} is the most in-demand skill with a demand score of ${trendingSkills[0]?.demand_score || 'N/A'}.`,
      topCareer ? `${topCareer} shows the strongest career demand growth right now.` : null,
      targetRoleSalary
        ? `${targetRoleSalary.career} entry salary: ${targetRoleSalary.entry_salary}, senior: ${targetRoleSalary.senior_salary}.`
        : null,
    ].filter(Boolean);

    logger.info('[MarketIntelligenceAgent] Done', {
      userId,
      skills: trendingSkills.length,
      careers: careerDemand.length,
      salaries: salaryBenchmarks.length,
    });

    return {
      trending_skills:    trendingSkills,
      career_demand:      careerDemand,
      salary_benchmarks:  salaryBenchmarks,
      target_role_salary: targetRoleSalary,
      market_insights:    insights,
    };
  }

  _require(path, name) {
    try { return require(path); }
    catch (err) {
      logger.warn(`[MarketIntelligenceAgent] ${name} unavailable`, { err: err.message });
      return null;
    }
  }
}

module.exports = MarketIntelligenceAgent;









