'use strict';

/**
 * opportunityRadar.engine.js — AI Career Opportunity Radar Engine
 *
 * Detects emerging career opportunities and future high-growth roles by
 * analysing labor market signals, skill demand trends, and industry data.
 *
 * Architecture:
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │  Data Inputs (read-only)                                         │
 *   │    Labor Market Intelligence  — career trends, skill demand      │
 *   │    Supabase career_opportunity_signals — persisted signals       │
 *   │    SkillGraphEngine  — skill relationships for match scoring      │
 *   │    Firestore userProfiles  — user skills + profile               │
 *   └──────────────────────────────────────────────────────────────────┘
 *              ↓
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │  OpportunityRadarEngine                                          │
 *   │    detectOpportunitySignals()   — refresh market signals         │
 *   │    getOpportunityRadar(userId)  — personalised ranked results    │
 *   │    getEmergingRoles(opts)       — public emerging role catalogue  │
 *   │    _calculateOpportunityScore() — scoring formula                │
 *   │    _calculateMatchScore()       — user↔role match                │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * Scoring Formula:
 *   opportunity_score = 0.35 × job_growth_rate
 *                     + 0.25 × salary_growth_rate
 *                     + 0.25 × skill_demand_growth
 *                     + 0.15 × industry_growth
 *
 * Match Formula:
 *   match_score = (skills_overlap / required_skills) × 100
 *   Bonus: +5 per semantic skill match via SkillGraphEngine
 *
 * Caching:
 *   Redis key  : radar:signals          — full signals list (30 min)
 *   Redis key  : radar:user:<userId>    — personalised matches (30 min)
 *   Redis key  : radar:emerging:<opts>  — emerging roles list (30 min)
 *
 * @module src/engines/opportunityRadar.engine
 */
const cacheManager = require('../core/cache/cache.manager');
const supabase = require('../core/supabaseClient');
const logger = require('../utils/logger');
const {
  db
} = require('../config/supabase');

// ─── Config ───────────────────────────────────────────────────────────────────

const CACHE_TTL_SECONDS = 1800; // 30 minutes

// Opportunity scoring weights (must sum to 1.0)
const OPP_WEIGHTS = Object.freeze({
  job_growth: 0.35,
  salary_growth: 0.25,
  skill_demand: 0.25,
  industry_growth: 0.15
});

// Thresholds for growth_trend label
const TREND_LABELS = [{
  min: 80,
  label: 'Very High'
}, {
  min: 60,
  label: 'High'
}, {
  min: 40,
  label: 'Moderate'
}, {
  min: 20,
  label: 'Emerging'
}, {
  min: 0,
  label: 'Stable'
}];

// Normalisation ceilings
const CEILINGS = Object.freeze({
  growth_rate: 100,
  // 100% YoY = absolute max
  salary_growth: 60,
  // 60% YoY salary growth = extreme
  skill_demand: 100,
  // demand_score already 0–100
  industry_growth: 50 // 50% industry growth = extreme
});
const cache = cacheManager.getClient();

// ─── Lazy service loaders (avoid circular deps) ───────────────────────────────

let _marketSvc = null;
let _skillGapSvc = null;
function getMarketSvc() {
  if (!_marketSvc) {
    try {
      _marketSvc = require('../modules/labor-market-intelligence/services/marketTrend.service');
    } catch (_) {}
  }
  return _marketSvc;
}
function getSkillGapSvc() {
  if (!_skillGapSvc) {
    try {
      _skillGapSvc = require('../modules/jobSeeker/skillGraphEngine.service');
    } catch (_) {}
  }
  return _skillGapSvc;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function _cached(key, ttl, fn) {
  try {
    const hit = await cache.get(key);
    if (hit) return JSON.parse(hit);
  } catch (_) {}
  const result = await fn();
  try {
    await cache.set(key, JSON.stringify(result), 'EX', ttl);
  } catch (_) {}
  return result;
}
function _normalise(value, ceiling) {
  if (!value || value <= 0 || !ceiling) return 0;
  return Math.min(100, Math.round(value / ceiling * 100));
}
function _growthTrendLabel(score) {
  for (const {
    min,
    label
  } of TREND_LABELS) {
    if (score >= min) return label;
  }
  return 'Stable';
}

// ─── _calculateOpportunityScore ───────────────────────────────────────────────

/**
 * Calculate opportunity score for a role from raw market signals.
 *
 * @param {{ growth_rate: number, salary_growth_rate: number, demand_score: number, industry_growth?: number }} signals
 * @returns {{ score: number, breakdown: object, trend: string }}
 */
function _calculateOpportunityScore(signals) {
  const jobGrowth = _normalise(signals.growth_rate || 0, CEILINGS.growth_rate);
  const salaryGrowth = _normalise(signals.salary_growth_rate || 0, CEILINGS.salary_growth);
  const skillDemand = _normalise(signals.demand_score || 0, CEILINGS.skill_demand);
  const industryGrowth = _normalise(signals.industry_growth || 0, CEILINGS.industry_growth);
  const score = Math.round(OPP_WEIGHTS.job_growth * jobGrowth + OPP_WEIGHTS.salary_growth * salaryGrowth + OPP_WEIGHTS.skill_demand * skillDemand + OPP_WEIGHTS.industry_growth * industryGrowth);
  return {
    score: Math.min(99, score),
    breakdown: {
      job_growth: Math.round(OPP_WEIGHTS.job_growth * jobGrowth),
      salary_growth: Math.round(OPP_WEIGHTS.salary_growth * salaryGrowth),
      skill_demand: Math.round(OPP_WEIGHTS.skill_demand * skillDemand),
      industry_growth: Math.round(OPP_WEIGHTS.industry_growth * industryGrowth)
    },
    trend: _growthTrendLabel(score)
  };
}

// ─── _calculateMatchScore ─────────────────────────────────────────────────────

/**
 * Calculate how well a user's skill profile matches an opportunity role.
 *
 * Algorithm:
 *   1. Direct overlap: exact matches between userSkills and requiredSkills
 *   2. Adjacent overlap: skills the user has that are semantically adjacent
 *      (via SkillGraph) to required skills — partial credit
 *
 * @param {string[]} userSkills
 * @param {string[]} requiredSkills
 * @param {string[]} [adjacentSkills] — from SkillGraph getUserSkillGraph
 * @returns {{ match_score: number, overlap: string[], to_learn: string[] }}
 */
function _calculateMatchScore(userSkills, requiredSkills, adjacentSkills = []) {
  if (!requiredSkills || requiredSkills.length === 0) {
    return {
      match_score: 50,
      overlap: userSkills.slice(0, 3),
      to_learn: []
    };
  }
  const userNorm = new Set(userSkills.map(s => s.toLowerCase().trim()));
  const adjacentNorm = new Set(adjacentSkills.map(s => s.toLowerCase().trim()));
  const overlap = [];
  const toLearn = [];
  let directMatches = 0;
  let adjacentMatches = 0;
  for (const req of requiredSkills) {
    const norm = req.toLowerCase().trim();
    if (userNorm.has(norm)) {
      directMatches++;
      overlap.push(req);
    } else if (adjacentNorm.has(norm)) {
      adjacentMatches++;
      // Partial credit for adjacent — counted separately
    } else {
      toLearn.push(req);
    }
  }

  // Direct match: full credit / Adjacent: half credit
  const rawScore = (directMatches + adjacentMatches * 0.5) / requiredSkills.length * 100;
  const matchScore = Math.min(95, Math.round(rawScore));
  return {
    match_score: matchScore,
    overlap: overlap.slice(0, 8),
    to_learn: toLearn.slice(0, 6)
  };
}

// ─── _loadUserProfile ─────────────────────────────────────────────────────────

async function _loadUserProfile(userId) {
  const [profileSnap, progressSnap] = await Promise.all([supabase.from('userProfiles').select("*").eq("id", userId).single(), supabase.from('onboardingProgress').select("*").eq("id", userId).single()]);
  const profile = profileSnap.exists ? profileSnap.data() : {};
  const progress = progressSnap.exists ? progressSnap.data() : {};
  const rawSkills = Array.isArray(profile.skills) && profile.skills.length > 0 ? profile.skills : Array.isArray(progress.skills) ? progress.skills : [];
  const skills = rawSkills.map(s => typeof s === 'string' ? s : s?.name).filter(Boolean);
  return {
    skills,
    targetRole: profile.targetRole || profile.currentJobTitle || null,
    industry: profile.industry || null,
    yearsExperience: profile.experienceYears || profile.yearsExperience || 0
  };
}

// ─── detectOpportunitySignals ─────────────────────────────────────────────────

/**
 * Refresh the career_opportunity_signals table from LMI data.
 *
 * Reads career trends and skill demand from the Labor Market Intelligence
 * service, recalculates opportunity scores, and upserts into Supabase.
 *
 * Called by: scheduled job / admin endpoint POST /api/career/opportunity-radar/refresh
 *
 * @returns {Promise<{ upserted: number, total: number, duration_ms: number }>}
 */
async function detectOpportunitySignals() {
  const startMs = Date.now();
  logger.info('[OpportunityRadar] detectOpportunitySignals start');
  const marketSvc = getMarketSvc();
  if (!marketSvc) {
    logger.warn('[OpportunityRadar] marketTrend.service unavailable — using seeded data only');
    return {
      upserted: 0,
      total: 0,
      duration_ms: Date.now() - startMs
    };
  }

  // Load LMI data in parallel
  const [careerTrendsRes, skillDemandRes] = await Promise.allSettled([marketSvc.getCareerTrends(), marketSvc.getSkillDemand(50)]);
  const careerTrends = careerTrendsRes.status === 'fulfilled' ? careerTrendsRes.value : [];
  const skillDemand = skillDemandRes.status === 'fulfilled' ? skillDemandRes.value : [];

  // Build skill demand lookup for fast access
  const skillDemandMap = new Map(skillDemand.map(s => [(s.skill_name || s.name || '').toLowerCase(), s.demand_score || s.score || 0]));
  const signals = [];
  for (const trend of careerTrends) {
    const roleName = trend.career || trend.role_name || trend.title;
    if (!roleName) continue;
    const growthRate = trend.growth_rate || trend.trend_score || 0;
    const salaryGrowthRate = trend.salary_growth || trend.salary_increase || 0;
    const industryGrowth = trend.industry_growth || 0;

    // Aggregate demand score from role's typical skills
    const roleSkills = trend.top_skills || trend.required_skills || [];
    const demandScores = roleSkills.map(s => skillDemandMap.get(s.toLowerCase()) || 0).filter(v => v > 0);
    const avgDemandScore = demandScores.length > 0 ? Math.round(demandScores.reduce((a, b) => a + b, 0) / demandScores.length) : trend.demand_score || 50;
    const {
      score,
      breakdown,
      trend: trendLabel
    } = _calculateOpportunityScore({
      growth_rate: growthRate,
      salary_growth_rate: salaryGrowthRate,
      demand_score: avgDemandScore,
      industry_growth: industryGrowth
    });

    // Format salary
    const avgSalaryRaw = trend.avg_salary || trend.median_salary || 0;
    const avgSalary = avgSalaryRaw >= 100000 ? `₹${Math.round(avgSalaryRaw / 100000)}L` : avgSalaryRaw > 0 ? `₹${avgSalaryRaw.toLocaleString('en-IN')}` : 'Market Rate';
    signals.push({
      role_name: roleName,
      industry: trend.industry || 'Technology',
      growth_rate: growthRate,
      salary_growth_rate: salaryGrowthRate,
      average_salary: avgSalary,
      average_salary_raw: avgSalaryRaw,
      demand_score: avgDemandScore,
      emerging_score: trend.emerging_score || Math.min(95, score + 5),
      opportunity_score: score,
      score_breakdown: breakdown,
      required_skills: roleSkills.slice(0, 10),
      growth_trend: trendLabel,
      is_emerging: growthRate > 40 || (trend.emerging_score || 0) > 70,
      data_source: 'lmi'
    });
  }

  // Upsert to Supabase in batches of 20
  let upserted = 0;
  const BATCH = 20;
  for (let i = 0; i < signals.length; i += BATCH) {
    const chunk = signals.slice(i, i + BATCH);
    const {
      error
    } = await supabase.from('career_opportunity_signals').upsert(chunk, {
      onConflict: 'role_name,industry'
    });
    if (error) {
      logger.error('[OpportunityRadar] upsert error', {
        error: error.message
      });
    } else {
      upserted += chunk.length;
    }
  }
  const durationMs = Date.now() - startMs;

  // Log the run
  await supabase.from('opportunity_radar_runs').insert({
    signals_upserted: upserted,
    signals_total: signals.length,
    duration_ms: durationMs,
    status: 'success'
  }).then(() => {}).catch(() => {});

  // Invalidate caches
  try {
    await cache.del('radar:signals');
    logger.info('[OpportunityRadar] cache invalidated');
  } catch (_) {}
  logger.info('[OpportunityRadar] detectOpportunitySignals complete', {
    upserted,
    total: signals.length,
    durationMs
  });
  return {
    upserted,
    total: signals.length,
    duration_ms: durationMs
  };
}

// ─── getOpportunityRadar ──────────────────────────────────────────────────────

/**
 * Get personalised emerging career opportunities for a user.
 *
 * Steps:
 *   1. Load user profile + skill graph from Firestore
 *   2. Load top opportunity signals from Supabase
 *   3. Score each signal against user's skill profile
 *   4. Sort by combined (opportunity_score + match_score), return top N
 *
 * @param {string} userId
 * @param {{ topN?: number, minOpportunityScore?: number, minMatchScore?: number }} opts
 * @returns {Promise<OpportunityRadarResult>}
 */
async function getOpportunityRadar(userId, opts = {}) {
  const {
    topN = 10,
    minOpportunityScore = 40,
    minMatchScore = 0
  } = opts;
  const cacheKey = `radar:user:${userId}:${topN}:${minOpportunityScore}`;
  return _cached(cacheKey, CACHE_TTL_SECONDS, async () => {
    // 1. Load user profile
    let userProfile;
    try {
      userProfile = await _loadUserProfile(userId);
    } catch (err) {
      logger.warn('[OpportunityRadar] profile load failed', {
        userId,
        err: err.message
      });
      userProfile = {
        skills: [],
        targetRole: null,
        industry: null,
        yearsExperience: 0
      };
    }

    // 2. Load adjacent skills for partial match credit
    let adjacentSkills = [];
    try {
      const skillGapSvc = getSkillGapSvc();
      if (skillGapSvc && userProfile.skills.length > 0) {
        const graphData = await skillGapSvc.getUserSkillGraph(userId);
        adjacentSkills = graphData?.adjacent_skills || [];
      }
    } catch (_) {}

    // 3. Load opportunity signals from Supabase
    const signals = await _getSignals(minOpportunityScore);
    if (signals.length === 0) {
      return {
        emerging_opportunities: [],
        user_skills_count: userProfile.skills.length,
        target_role: userProfile.targetRole,
        industry: userProfile.industry,
        message: 'No opportunity signals available yet. Check back after market data refreshes.'
      };
    }

    // 4. Score each signal against user
    const scored = [];
    for (const signal of signals) {
      const requiredSkills = Array.isArray(signal.required_skills) ? signal.required_skills : typeof signal.required_skills === 'string' ? JSON.parse(signal.required_skills) : [];
      const {
        match_score,
        overlap,
        to_learn
      } = _calculateMatchScore(userProfile.skills, requiredSkills, adjacentSkills);
      if (match_score < minMatchScore) continue;

      // Persist match to Supabase for analytics (non-blocking)
      supabase.from('user_opportunity_matches').upsert({
        user_id: userId,
        signal_id: signal.id,
        match_score,
        skills_overlap: overlap,
        skills_to_learn: to_learn
      }, {
        onConflict: 'user_id,signal_id'
      }).then(() => {}).catch(() => {});
      scored.push({
        role: signal.role_name,
        industry: signal.industry,
        opportunity_score: signal.opportunity_score,
        match_score,
        growth_trend: signal.growth_trend,
        average_salary: signal.average_salary,
        is_emerging: signal.is_emerging,
        skills_you_have: overlap,
        skills_to_learn: to_learn,
        score_breakdown: signal.score_breakdown,
        // Combined ranking score (opportunity matters more than match for discovery)
        _rank: signal.opportunity_score * 0.6 + match_score * 0.4
      });
    }

    // 5. Sort by rank, return top N
    const topOpportunities = scored.sort((a, b) => b._rank - a._rank).slice(0, topN).map(({
      _rank,
      ...rest
    }) => rest); // strip internal _rank field

    logger.info('[OpportunityRadar] getOpportunityRadar', {
      userId,
      evaluated: signals.length,
      returned: topOpportunities.length
    });
    return {
      emerging_opportunities: topOpportunities,
      user_skills_count: userProfile.skills.length,
      target_role: userProfile.targetRole,
      industry: userProfile.industry,
      total_signals_evaluated: signals.length
    };
  });
}

// ─── getEmergingRoles ─────────────────────────────────────────────────────────

/**
 * Get the catalogue of top emerging roles — not personalised.
 * Used by the public-facing radar dashboard and admin screens.
 *
 * @param {{ limit?: number, industry?: string, emergingOnly?: boolean, minScore?: number }} opts
 * @returns {Promise<{ roles: object[], total: number }>}
 */
async function getEmergingRoles(opts = {}) {
  const {
    limit = 20,
    industry = null,
    emergingOnly = false,
    minScore = 60
  } = opts;
  const cacheKey = `radar:emerging:${limit}:${industry || 'all'}:${emergingOnly}:${minScore}`;
  return _cached(cacheKey, CACHE_TTL_SECONDS, async () => {
    let query = supabase.from('career_opportunity_signals').select('*').gte('opportunity_score', minScore).order('opportunity_score', {
      ascending: false
    }).limit(limit);
    if (industry) query = query.eq('industry', industry);
    if (emergingOnly) query = query.eq('is_emerging', true);
    const {
      data,
      error
    } = await query;
    if (error) {
      logger.error('[OpportunityRadar] getEmergingRoles error', {
        error: error.message
      });
      return {
        roles: [],
        total: 0
      };
    }
    const roles = (data || []).map(signal => ({
      role: signal.role_name,
      industry: signal.industry,
      opportunity_score: signal.opportunity_score,
      growth_trend: signal.growth_trend,
      average_salary: signal.average_salary,
      demand_score: signal.demand_score,
      emerging_score: signal.emerging_score,
      is_emerging: signal.is_emerging,
      required_skills: Array.isArray(signal.required_skills) ? signal.required_skills : JSON.parse(signal.required_skills || '[]'),
      score_breakdown: signal.score_breakdown
    }));
    return {
      roles,
      total: roles.length
    };
  });
}

// ─── _getSignals (internal) ───────────────────────────────────────────────────

async function _getSignals(minScore = 0) {
  const cacheKey = `radar:signals:${minScore}`;
  return _cached(cacheKey, CACHE_TTL_SECONDS, async () => {
    const {
      data,
      error
    } = await supabase.from('career_opportunity_signals').select('*').gte('opportunity_score', minScore).order('opportunity_score', {
      ascending: false
    }).limit(50);
    if (error) {
      logger.error('[OpportunityRadar] _getSignals error', {
        error: error.message
      });
      return [];
    }
    return data || [];
  });
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  detectOpportunitySignals,
  getOpportunityRadar,
  getEmergingRoles,
  // Exposed for testing
  _calculateOpportunityScore,
  _calculateMatchScore,
  OPP_WEIGHTS
};