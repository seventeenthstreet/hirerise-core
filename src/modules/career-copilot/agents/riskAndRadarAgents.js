'use strict';

/**
 * @file src/modules/career-copilot/agents/riskAndOpportunityAgents.js
 * @description
 * Production-grade Risk + Opportunity agents.
 *
 * Optimized for:
 * - Supabase-safe row queries
 * - unified freshness logic
 * - live engine graceful degradation
 * - null-safe shaping
 * - maintainability
 */

const BaseAgent = require('./baseAgent');
const { supabase } = require('../../../config/supabase');
const logger = require('../../../utils/logger');

const careerRiskEngine = safeRequireMany([
  '../../../engines/careerRisk.engine',
  '../../../modules/careerRisk/careerRisk.engine',
]);

const opportunityRadarEngine = safeRequire(
  '../../../engines/opportunityRadar.engine',
  'OpportunityRadarEngine'
);

const PRECOMPUTED_MAX_AGE_HOURS = Number(
  process.env.PRECOMPUTED_AGENT_MAX_AGE_HOURS || 24
);

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────
function isFreshTimestamp(computedAt) {
  if (!computedAt) return false;

  const ts = new Date(computedAt).getTime();
  if (!Number.isFinite(ts)) return false;

  const ageMs = Date.now() - ts;
  const maxAgeMs =
    PRECOMPUTED_MAX_AGE_HOURS * 60 * 60 * 1000;

  return ageMs >= 0 && ageMs <= maxAgeMs;
}

function clampScore(value) {
  const numeric = Number(value || 0);
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Career Risk Agent
// ─────────────────────────────────────────────────────────────────────────────
class CareerRiskAgent extends BaseAgent {
  get agentName() {
    return 'CareerRiskAgent';
  }

  get cachePrefix() {
    return 'agent:risk';
  }

  async run(userId, context = {}) {
    const stored = await this.getStoredRiskResult(userId);

    if (
      stored &&
      stored.overall_risk_score != null &&
      isFreshTimestamp(stored.computed_at)
    ) {
      logger.info('[CareerRiskAgent] Using precomputed result', {
        userId,
      });

      return this.shape({
        score: stored.overall_risk_score,
        level: stored.risk_level,
        factors: stored.risk_factors,
        recommendations: stored.recommendations,
        source: 'precomputed',
        computedAt: stored.computed_at,
      });
    }

    if (careerRiskEngine?.analyzeCareerRisk) {
      try {
        const result =
          await careerRiskEngine.analyzeCareerRisk(userId);

        return this.shape({
          score:
            result?.overall_risk_score ??
            result?.riskScore ??
            0,
          level:
            result?.risk_level ??
            result?.riskLevel ??
            'Unknown',
          factors:
            result?.risk_factors ??
            result?.factors ??
            [],
          recommendations:
            result?.recommendations ?? [],
          source: 'live',
        });
      } catch (err) {
        logger.warn(
          '[CareerRiskAgent] Live engine failed, using heuristic',
          {
            userId,
            error: err.message,
          }
        );
      }
    }

    logger.warn('[CareerRiskAgent] Using heuristic derivation', {
      userId,
    });

    return this.deriveFromContext(context);
  }

  async getStoredRiskResult(userId) {
    try {
      const { data, error } = await supabase
        .from('risk_analysis_results')
        .select(
          'overall_risk_score, risk_level, risk_factors, recommendations, computed_at'
        )
        .eq('user_id', userId)
        .maybeSingle();

      if (error) throw error;
      return data || null;
    } catch (err) {
      logger.warn('[CareerRiskAgent] Stored fetch failed', {
        userId,
        error: err.message,
      });
      return null;
    }
  }

  shape({
    score = 0,
    level = 'Unknown',
    factors = [],
    recommendations = [],
    source = 'unknown',
    computedAt = null,
  }) {
    const normalizedScore = clampScore(score);

    const normalizedFactors = (Array.isArray(factors)
      ? factors
      : []
    )
      .slice(0, 5)
      .map((factor) =>
        typeof factor === 'string'
          ? {
              factor,
              description: null,
              score: null,
            }
          : {
              factor:
                factor?.factor ||
                factor?.name ||
                null,
              description:
                factor?.description || null,
              score:
                factor?.score != null
                  ? clampScore(factor.score)
                  : null,
            }
      )
      .filter((factor) => factor.factor);

    const stabilityInsight =
      normalizedScore <= 30
        ? `Career risk is ${level} — your skills are aligned with market demand.`
        : normalizedScore <= 60
          ? 'Moderate career risk detected — focused upskilling is recommended.'
          : 'High career risk detected — major upskilling or role pivot is advisable.';

    return {
      overall_risk_score: normalizedScore,
      risk_level: level,
      risk_factors: normalizedFactors,
      recommendations: (Array.isArray(recommendations)
        ? recommendations
        : []
      ).slice(0, 4),
      stability_insight: stabilityInsight,
      source,
      _computed_at:
        source === 'precomputed' ? computedAt : null,
    };
  }

  deriveFromContext(context = {}) {
    const skills = Array.isArray(
      context?.existing_skills || context?.skills
    )
      ? context.existing_skills || context.skills
      : [];

    const years = Number(
      context?.years_experience ??
      context?.yearsExperience ??
      0
    );

    const techKeywords = [
      'python',
      'sql',
      'power bi',
      'machine learning',
      'cloud',
      'data',
      'api',
    ];

    const techCount = skills.filter((skill) =>
      techKeywords.some((keyword) =>
        String(skill).toLowerCase().includes(keyword)
      )
    ).length;

    const score =
      techCount >= 3 ? 25 : techCount >= 1 ? 45 : 65;

    const level =
      score <= 30 ? 'Low' : score <= 50 ? 'Moderate' : 'High';

    return this.shape({
      score,
      level,
      factors: [
        {
          factor: 'Skill Currency',
          description:
            techCount > 0
              ? 'Has relevant technical skills'
              : 'Limited technical skill depth',
          score,
        },
        {
          factor: 'Experience Depth',
          description:
            years >= 3
              ? 'Solid experience base'
              : 'Early career stage',
        },
      ],
      recommendations: [
        'Upskill in high-demand areas',
        'Build specialized domain expertise',
      ],
      source: 'derived',
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Opportunity Radar Agent
// ─────────────────────────────────────────────────────────────────────────────
class OpportunityRadarAgent extends BaseAgent {
  get agentName() {
    return 'OpportunityRadarAgent';
  }

  get cachePrefix() {
    return 'agent:radar';
  }

  async run(userId, context = {}) {
    const stored = await this.getStoredRadarResult(userId);

    if (
      stored?.emerging_opportunities?.length &&
      isFreshTimestamp(stored.computed_at)
    ) {
      logger.info(
        '[OpportunityRadarAgent] Using precomputed result',
        { userId }
      );

      return this.shape({
        rawOpportunities:
          stored.emerging_opportunities,
        totalEvaluated:
          stored.total_signals_evaluated,
        source: 'precomputed',
        computedAt: stored.computed_at,
      });
    }

    if (opportunityRadarEngine?.getOpportunityRadar) {
      try {
        const result =
          await opportunityRadarEngine.getOpportunityRadar(
            userId,
            {
              topN: 8,
              minOpportunityScore: 40,
              context,
            }
          );

        return this.shape({
          rawOpportunities:
            result?.emerging_opportunities,
          totalEvaluated:
            result?.total_signals_evaluated,
          source: 'live',
        });
      } catch (err) {
        logger.warn(
          '[OpportunityRadarAgent] Live engine failed',
          {
            userId,
            error: err.message,
          }
        );
      }
    }

    return this.shape({
      rawOpportunities: [],
      totalEvaluated: 0,
      source: 'derived',
    });
  }

  async getStoredRadarResult(userId) {
    try {
      const { data, error } = await supabase
        .from('opportunity_radar_results')
        .select(
          'emerging_opportunities, total_signals_evaluated, computed_at'
        )
        .eq('user_id', userId)
        .maybeSingle();

      if (error) throw error;
      return data || null;
    } catch (err) {
      logger.warn(
        '[OpportunityRadarAgent] Stored fetch failed',
        {
          userId,
          error: err.message,
        }
      );
      return null;
    }
  }

  shape({
    rawOpportunities = [],
    totalEvaluated = 0,
    source = 'unknown',
    computedAt = null,
  }) {
    const opportunities = (Array.isArray(rawOpportunities)
      ? rawOpportunities
      : []
    )
      .slice(0, 8)
      .map((opp) => ({
        role: opp?.role || opp?.role_name || null,
        opportunity_score: clampScore(
          opp?.opportunity_score ??
          opp?.growth_score
        ),
        match_score:
          opp?.match_score != null
            ? clampScore(opp.match_score)
            : null,
        growth_trend: opp?.growth_trend || null,
        average_salary:
          opp?.average_salary || null,
        skills_to_learn: Array.isArray(
          opp?.skills_to_learn
        )
          ? opp.skills_to_learn.slice(0, 4)
          : [],
        industry: opp?.industry || null,
      }))
      .filter((opp) => opp.role);

    const topOpportunity = opportunities[0] || null;

    return {
      emerging_opportunities: opportunities,
      top_opportunity: topOpportunity,
      total_signals_evaluated: Number(
        totalEvaluated || 0
      ),
      source,
      _computed_at:
        source === 'precomputed' ? computedAt : null,
      summary: topOpportunity
        ? `${topOpportunity.role} is your top emerging opportunity (${topOpportunity.opportunity_score}/100).`
        : 'No opportunity radar data available yet.',
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Safe requires
// ─────────────────────────────────────────────────────────────────────────────
function safeRequire(path, name) {
  try {
    return require(path);
  } catch (err) {
    logger.warn(
      `[RiskOpportunityAgents] ${name} unavailable`,
      {
        error: err instanceof Error
          ? err.message
          : 'Unknown require error',
      }
    );
    return null;
  }
}

function safeRequireMany(paths = []) {
  for (const path of paths) {
    try {
      return require(path);
    } catch {}
  }

  return null;
}

module.exports = {
  CareerRiskAgent,
  OpportunityRadarAgent,
};