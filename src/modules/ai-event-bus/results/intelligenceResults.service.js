'use strict';

/**
 * intelligenceResults.service.js — Intelligence Results Reader
 *
 * Dashboard-facing service. Returns pre-computed AI engine results
 * from Supabase result tables (written by async workers).
 *
 * API behavior:
 *   Dashboard does NOT trigger engines directly.
 *   It calls these functions → results are returned from DB + cache.
 *   If results don't exist yet, a 'pending' status is returned with
 *   instructions to poll /api/career/pipeline-status/:jobId.
 *
 * Cache strategy (10-minute TTL):
 *   1. Check Redis cache (fast path)
 *   2. Read from Supabase result table
 *   3. Write to Redis cache
 *   4. Return to caller
 *
 * @module src/modules/ai-event-bus/results/intelligenceResults.service
 */

'use strict';

const supabase       = require('../../core/supabaseClient');
const cacheManager   = require('../../core/cache/cache.manager');
const logger         = require('../../utils/logger');

const CACHE_TTL = 600;  // 10 minutes
const cache     = cacheManager.getClient();

// ─── Cache helper ─────────────────────────────────────────────────────────────

async function _fromCacheOrDB(cacheKey, dbFn) {
  // 1. Redis fast path
  try {
    const hit = await cache.get(cacheKey);
    if (hit) return { ...JSON.parse(hit), _cached: true };
  } catch (_) {}

  // 2. Supabase
  const result = await dbFn();

  // 3. Cache on hit
  if (result) {
    try { await cache.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL); } catch (_) {}
  }

  return result;
}

// ─── Not-ready sentinel ───────────────────────────────────────────────────────

function _pending(resource) {
  return {
    _status:  'pending',
    _message: `${resource} is being computed. Check pipeline-status for updates.`,
    data:     null,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// getIntelligenceReport — GET /api/career/intelligence-report
// Returns all available results merged into a single report
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Fetch all available engine results for a user and merge into one report.
 * Each section is independently available — partial results are returned
 * if some workers haven't completed yet.
 *
 * @param {string} userId
 * @returns {Promise<IntelligenceReport>}
 */
async function getIntelligenceReport(userId) {
  const cacheKey = `dashboard:intelligence-report:${userId}`;

  return _fromCacheOrDB(cacheKey, async () => {
    // Fetch all result tables in parallel
    const [healthRes, matchRes, riskRes, radarRes, adviceRes] = await Promise.allSettled([
      supabase.from('career_health_results')     .select('*').eq('user_id', userId).maybeSingle(),
      supabase.from('job_match_results')          .select('*').eq('user_id', userId).maybeSingle(),
      supabase.from('risk_analysis_results')      .select('*').eq('user_id', userId).maybeSingle(),
      supabase.from('opportunity_radar_results')  .select('*').eq('user_id', userId).maybeSingle(),
      supabase.from('career_advice_results')      .select('*').eq('user_id', userId).maybeSingle(),
    ]);

    const health = healthRes.status === 'fulfilled' ? healthRes.value.data : null;
    const match  = matchRes.status  === 'fulfilled' ? matchRes.value.data  : null;
    const risk   = riskRes.status   === 'fulfilled' ? riskRes.value.data   : null;
    const radar  = radarRes.status  === 'fulfilled' ? radarRes.value.data  : null;
    const advice = adviceRes.status === 'fulfilled' ? adviceRes.value.data : null;

    return {
      user_id:     userId,
      generated_at: new Date().toISOString(),
      career_health: health ? {
        chi_score:       health.chi_score,
        dimensions:      health.dimensions,
        skill_gaps:      health.skill_gaps       || [],
        analysis_source: health.analysis_source,
        computed_at:     health.computed_at,
      } : null,
      job_matches: match ? {
        recommended_jobs:  match.recommended_jobs  || [],
        total_evaluated:   match.total_evaluated,
        scoring_mode:      match.scoring_mode,
        computed_at:       match.computed_at,
      } : null,
      risk_analysis: risk ? {
        overall_risk_score: risk.overall_risk_score,
        risk_level:         risk.risk_level,
        risk_factors:       risk.risk_factors       || [],
        recommendations:    risk.recommendations    || [],
        computed_at:        risk.computed_at,
      } : null,
      opportunity_radar: radar ? {
        emerging_opportunities:  radar.emerging_opportunities  || [],
        total_signals_evaluated: radar.total_signals_evaluated,
        computed_at:             radar.computed_at,
      } : null,
      career_advice: advice ? {
        career_insight:       advice.career_insight,
        key_opportunity:      advice.key_opportunity,
        salary_potential:     advice.salary_potential,
        timeline:             advice.timeline,
        skills_to_prioritise: advice.skills_to_prioritise || [],
        computed_at:          advice.computed_at,
      } : null,
    };
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// getJobMatches — GET /api/jobs/matches
// ═════════════════════════════════════════════════════════════════════════════

async function getJobMatches(userId) {
  const cacheKey = `dashboard:job-matches:${userId}`;

  return _fromCacheOrDB(cacheKey, async () => {
    const { data, error } = await supabase
      .from('job_match_results')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      logger.warn('[IntelligenceResults] getJobMatches error', { userId, err: error.message });
      return _pending('Job matches');
    }

    if (!data) return _pending('Job matches');

    return {
      recommended_jobs:  data.recommended_jobs  || [],
      total_evaluated:   data.total_evaluated,
      user_skills_count: data.user_skills_count,
      scoring_mode:      data.scoring_mode,
      computed_at:       data.computed_at,
    };
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// getRiskAnalysis — GET /api/career/risk
// ═════════════════════════════════════════════════════════════════════════════

async function getRiskAnalysis(userId) {
  const cacheKey = `dashboard:risk-analysis:${userId}`;

  return _fromCacheOrDB(cacheKey, async () => {
    const { data, error } = await supabase
      .from('risk_analysis_results')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error || !data) return _pending('Risk analysis');

    return {
      overall_risk_score: data.overall_risk_score,
      risk_level:         data.risk_level,
      risk_factors:       data.risk_factors    || [],
      recommendations:    data.recommendations || [],
      market_stability:   data.market_stability,
      computed_at:        data.computed_at,
    };
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// getOpportunities — GET /api/career/opportunities
// ═════════════════════════════════════════════════════════════════════════════

async function getOpportunities(userId) {
  const cacheKey = `dashboard:opportunities:${userId}`;

  return _fromCacheOrDB(cacheKey, async () => {
    const { data, error } = await supabase
      .from('opportunity_radar_results')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error || !data) return _pending('Opportunity radar');

    return {
      emerging_opportunities:  data.emerging_opportunities  || [],
      total_signals_evaluated: data.total_signals_evaluated,
      computed_at:             data.computed_at,
    };
  });
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  getIntelligenceReport,
  getJobMatches,
  getRiskAnalysis,
  getOpportunities,
};









