'use strict';

/**
 * careerRiskAgent.js — Career Risk Agent
 *
 * Uses: Career Risk Predictor Engine
 *
 * Primary data source: Supabase risk_analysis_results table
 * (written by the async RiskAnalysisWorker from the event bus).
 * Falls back to a live engine call if precomputed data not available.
 *
 * Output:
 *   overall_risk_score  — 0-100
 *   risk_level          — 'Low' | 'Moderate' | 'High' | 'Critical'
 *   risk_factors        — [{ factor, description, score }]
 *   recommendations     — string[]
 *   stability_insight   — short sentence for advisor prompt
 *
 * File location: src/modules/career-copilot/agents/careerRiskAgent.js
 *
 * @module src/modules/career-copilot/agents/careerRiskAgent
 */

const BaseAgent = require('./baseAgent');
const supabase  = require('../../../core/supabaseClient');
const logger    = require('../../../utils/logger');

class CareerRiskAgent extends BaseAgent {

  get agentName()   { return 'CareerRiskAgent'; }
  get cachePrefix() { return 'agent:risk'; }

  async run(userId, context) {

    // ── 1. Check pre-computed Supabase result (fastest path) ──────────────────
    const { data: stored } = await supabase
      .from('risk_analysis_results')
      .select('overall_risk_score, risk_level, risk_factors, recommendations, computed_at')
      .eq('user_id', userId)
      .maybeSingle();

    if (stored?.overall_risk_score !== null && stored?.overall_risk_score !== undefined) {
      logger.info('[CareerRiskAgent] Using precomputed result', { userId });

      return this._shape(
        stored.overall_risk_score,
        stored.risk_level,
        stored.risk_factors    || [],
        stored.recommendations || [],
        'precomputed'
      );
    }

    // ── 2. Try live risk engine ───────────────────────────────────────────────
    let riskEngine = null;
    for (const path of [
      '../../../engines/careerRisk.engine',
      '../../../modules/careerRisk/careerRisk.engine',
    ]) {
      try { riskEngine = require(path); break; }
      catch (_) {}
    }

    if (riskEngine?.analyzeCareerRisk) {
      const result = await riskEngine.analyzeCareerRisk(userId);
      return this._shape(
        result.overall_risk_score || result.riskScore  || 0,
        result.risk_level         || result.riskLevel  || 'Unknown',
        result.risk_factors       || result.factors    || [],
        result.recommendations    || [],
        'live'
      );
    }

    // ── 3. Context-derived heuristic (graceful degradation) ──────────────────
    logger.warn('[CareerRiskAgent] No engine available — deriving from context', { userId });
    return this._deriveFromContext(context);
  }

  _shape(score, level, factors, recommendations, source) {
    const normFactors = (factors || []).slice(0, 5).map(f =>
      typeof f === 'string'
        ? { factor: f, description: null, score: null }
        : { factor: f.factor || f.name, description: f.description || null, score: f.score ?? null }
    );

    const stability = score <= 30
      ? `Career risk is ${level} — current skills are well-aligned with market demand.`
      : score <= 60
        ? `Moderate career risk detected — some upskilling recommended.`
        : `High career risk — significant upskilling or career pivot advisable.`;

    return {
      overall_risk_score: Math.round(score),
      risk_level:         level,
      risk_factors:       normFactors,
      recommendations:    (recommendations || []).slice(0, 4),
      stability_insight:  stability,
      source,
    };
  }

  _deriveFromContext(context) {
    const skills = context?.existing_skills || context?.skills || [];
    const yrs    = context?.years_experience || 0;

    const techKeywords = ['python', 'sql', 'power bi', 'machine learning', 'cloud', 'data', 'api'];
    const techCount = skills.filter(s =>
      techKeywords.some(k => s.toLowerCase().includes(k))
    ).length;

    const score = techCount >= 3 ? 25 : techCount >= 1 ? 45 : 65;
    const level = score <= 30 ? 'Low' : score <= 50 ? 'Moderate' : 'High';

    return this._shape(score, level, [
      { factor: 'Skill Currency', description: techCount > 0 ? 'Has some tech skills' : 'Limited tech skills', score },
      { factor: 'Experience Depth', description: yrs >= 3 ? 'Solid experience' : 'Early career stage', score: null },
    ], ['Upskill in high-demand areas', 'Build specialised domain expertise'], 'derived');
  }
}

// ═════════════════════════════════════════════════════════════════════════════

/**
 * opportunityRadarAgent.js — Opportunity Radar Agent
 *
 * Uses: AI Career Opportunity Radar
 *
 * Primary data source: Supabase opportunity_radar_results table.
 * Falls back to live opportunityRadar.engine call.
 *
 * Output:
 *   emerging_opportunities  — top scored emerging roles
 *   total_signals_evaluated — total signals the radar analysed
 *   top_opportunity         — single best opportunity for advisor prompt
 *
 * File location: src/modules/career-copilot/agents/opportunityRadarAgent.js
 *
 * @module src/modules/career-copilot/agents/opportunityRadarAgent
 */

class OpportunityRadarAgent extends BaseAgent {

  get agentName()   { return 'OpportunityRadarAgent'; }
  get cachePrefix() { return 'agent:radar'; }

  async run(userId, context) {

    // ── 1. Precomputed result from Supabase (written by OpportunityRadarWorker) ─
    const { data: stored } = await supabase
      .from('opportunity_radar_results')
      .select('emerging_opportunities, total_signals_evaluated, computed_at')
      .eq('user_id', userId)
      .maybeSingle();

    if (stored?.emerging_opportunities?.length > 0) {
      logger.info('[OpportunityRadarAgent] Using precomputed result', { userId });
      return this._shape(
        stored.emerging_opportunities,
        stored.total_signals_evaluated || 0,
        'precomputed'
      );
    }

    // ── 2. Live engine ────────────────────────────────────────────────────────
    let engine = null;
    try { engine = require('../../../engines/opportunityRadar.engine'); } catch (_) {}

    if (engine?.getOpportunityRadar) {
      const result = await engine.getOpportunityRadar(userId, {
        topN: 8,
        minOpportunityScore: 40,
      });
      return this._shape(
        result?.emerging_opportunities || [],
        result?.total_signals_evaluated || 0,
        'live'
      );
    }

    throw new Error('OpportunityRadarEngine unavailable — run opportunity-radar/refresh first');
  }

  _shape(rawOpps, totalEvaluated, source) {
    const opportunities = (rawOpps || []).slice(0, 8).map(o => ({
      role:              o.role              || o.role_name,
      opportunity_score: Math.round(o.opportunity_score || o.growth_score || 0),
      match_score:       o.match_score !== undefined ? Math.round(o.match_score) : null,
      growth_trend:      o.growth_trend      || null,
      average_salary:    o.average_salary    || null,
      skills_to_learn:   (o.skills_to_learn  || []).slice(0, 4),
      industry:          o.industry          || null,
    }));

    const top = opportunities[0] || null;

    return {
      emerging_opportunities:  opportunities,
      top_opportunity:         top,
      total_signals_evaluated: totalEvaluated,
      source,
      summary: top
        ? `${top.role} is your top emerging opportunity (score: ${top.opportunity_score}).`
        : 'No opportunity radar data yet. Run a full analysis to populate.',
    };
  }
}

module.exports = { CareerRiskAgent, OpportunityRadarAgent };









