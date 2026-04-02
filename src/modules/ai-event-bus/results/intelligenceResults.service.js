'use strict';

/**
 * intelligenceResults.service.js — Supabase + Redis optimized
 *
 * Firebase: none in original.
 * Optimizations:
 * - Column-select minimization instead of select('*')
 * - Better cache serialization safety
 * - Shared DB helpers reduce duplicate logic
 * - Faster partial report aggregation
 * - Optional stale-while-revalidate friendly structure
 */

const supabase = require('../../config/supabase');
const cacheManager = require('../../core/cache/cache.manager');
const logger = require('../../../utils/logger');

const CACHE_TTL = 600;
const cache = cacheManager.getClient();
const now = () => new Date().toISOString();

async function fromCacheOrDB(cacheKey, dbFn) {
  try {
    const cached = await cache.get(cacheKey);
    if (cached) return { ...JSON.parse(cached), _cached: true };
  } catch (error) {
    logger.debug('[IntelligenceResults] Cache read miss', { cacheKey });
  }

  const result = await dbFn();

  if (result) {
    try {
      await cache.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL);
    } catch (error) {
      logger.debug('[IntelligenceResults] Cache write skipped', { cacheKey });
    }
  }

  return result;
}

function pending(resource) {
  return {
    _status: 'pending',
    _message: `${resource} is being computed. Check pipeline-status for updates.`,
    data: null,
  };
}

async function fetchSingle(table, userId, columns) {
  const { data, error } = await supabase
    .from(table)
    .select(columns)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    logger.warn('[IntelligenceResults] Query failed', {
      table,
      userId,
      error: error.message,
    });
    return null;
  }

  return data;
}

async function getIntelligenceReport(userId) {
  const cacheKey = `dashboard:intelligence-report:${userId}`;

  return fromCacheOrDB(cacheKey, async () => {
    const [health, match, risk, radar, advice] = await Promise.all([
      fetchSingle(
        'career_health_results',
        userId,
        'chi_score,dimensions,skill_gaps,analysis_source,computed_at'
      ),
      fetchSingle(
        'job_match_results',
        userId,
        'recommended_jobs,total_evaluated,scoring_mode,computed_at'
      ),
      fetchSingle(
        'risk_analysis_results',
        userId,
        'overall_risk_score,risk_level,risk_factors,recommendations,computed_at'
      ),
      fetchSingle(
        'opportunity_radar_results',
        userId,
        'emerging_opportunities,total_signals_evaluated,computed_at'
      ),
      fetchSingle(
        'career_advice_results',
        userId,
        'career_insight,key_opportunity,salary_potential,timeline,skills_to_prioritise,computed_at'
      ),
    ]);

    return {
      user_id: userId,
      generated_at: now(),
      career_health: health,
      job_matches: match,
      risk_analysis: risk,
      opportunity_radar: radar,
      career_advice: advice,
    };
  });
}

async function getJobMatches(userId) {
  const cacheKey = `dashboard:job-matches:${userId}`;

  return fromCacheOrDB(cacheKey, async () => {
    const data = await fetchSingle(
      'job_match_results',
      userId,
      'recommended_jobs,total_evaluated,user_skills_count,scoring_mode,computed_at'
    );

    return data || pending('Job matches');
  });
}

async function getRiskAnalysis(userId) {
  const cacheKey = `dashboard:risk-analysis:${userId}`;

  return fromCacheOrDB(cacheKey, async () => {
    const data = await fetchSingle(
      'risk_analysis_results',
      userId,
      'overall_risk_score,risk_level,risk_factors,recommendations,market_stability,computed_at'
    );

    return data || pending('Risk analysis');
  });
}

async function getOpportunities(userId) {
  const cacheKey = `dashboard:opportunities:${userId}`;

  return fromCacheOrDB(cacheKey, async () => {
    const data = await fetchSingle(
      'opportunity_radar_results',
      userId,
      'emerging_opportunities,total_signals_evaluated,computed_at'
    );

    return data || pending('Opportunity radar');
  });
}

module.exports = {
  getIntelligenceReport,
  getJobMatches,
  getRiskAnalysis,
  getOpportunities,
};