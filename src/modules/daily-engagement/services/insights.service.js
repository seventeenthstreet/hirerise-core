'use strict';

/**
 * modules/daily-engagement/services/insights.service.js
 *
 * Production-grade Daily Insights service.
 *
 * Improvements:
 * - fixes Supabase singleton import
 * - correct unread field usage
 * - filter-safe cache behavior
 * - better row selection ordering
 * - centralized cache helpers
 * - stronger null safety
 */

const { supabase } = require('../../../config/supabase');
const logger = require('../../../utils/logger');
const cacheManager = require('../../../core/cache/cache.manager');

const repo = require('../models/engagement.repository');
const {
  INSIGHT_TYPES,
  SOURCE_ENGINES,
  CacheKeys,
  CACHE_TTL_SEC,
  DAILY_INSIGHT_LIMIT,
} = require('../models/engagement.constants');

// ─────────────────────────────────────────────────────────────────────────────
// Lazy dependencies
// ─────────────────────────────────────────────────────────────────────────────

function getMarketTrend() {
  return require('../../labor-market-intelligence/services/marketTrend.service');
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache helpers
// ─────────────────────────────────────────────────────────────────────────────

function getCacheClient() {
  return cacheManager.getClient();
}

async function cacheGet(key) {
  try {
    const raw = await getCacheClient().get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    logger.debug('[InsightsService] Cache read failed', {
      key,
      error: error.message,
    });
    return null;
  }
}

async function cacheSet(key, value) {
  try {
    await getCacheClient().set(
      key,
      JSON.stringify(value),
      { ttl: CACHE_TTL_SEC }
    );
  } catch (error) {
    logger.debug('[InsightsService] Cache write failed', {
      key,
      error: error.message,
    });
  }
}

async function cacheDel(key) {
  try {
    await getCacheClient().delete(key);
  } catch (error) {
    logger.debug('[InsightsService] Cache delete failed', {
      key,
      error: error.message,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// External engine readers
// ─────────────────────────────────────────────────────────────────────────────

async function readSkillDemand() {
  try {
    return (await getMarketTrend().getSkillDemand()) ?? [];
  } catch (error) {
    logger.warn('[InsightsService] Skill demand read failed', {
      error: error.message,
    });
    return [];
  }
}

async function readCareerTrends() {
  try {
    return (await getMarketTrend().getCareerTrends()) ?? [];
  } catch (error) {
    logger.warn('[InsightsService] Career trends read failed', {
      error: error.message,
    });
    return [];
  }
}

async function readOpportunityRadar(userId) {
  try {
    const { data, error } = await supabase
      .from('career_opportunities')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    return data ?? null;
  } catch (error) {
    logger.warn('[InsightsService] Opportunity radar read failed', {
      userId,
      error: error.message,
    });
    return null;
  }
}

async function readJobMatches(userId) {
  try {
    const { data, error } = await supabase
      .from('job_matches')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    return data ?? null;
  } catch (error) {
    logger.warn('[InsightsService] Job matches read failed', {
      userId,
      error: error.message,
    });
    return null;
  }
}

async function readCareerRisk(userId) {
  try {
    const { data, error } = await supabase
      .from('career_risk')
      .select('*')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    return data ?? null;
  } catch (error) {
    logger.warn('[InsightsService] Career risk read failed', {
      userId,
      error: error.message,
    });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Insight builders
// ─────────────────────────────────────────────────────────────────────────────

function buildSkillDemandInsights(userId, skillDemand) {
  if (!Array.isArray(skillDemand)) return [];

  return skillDemand.slice(0, 3).map((skill) => ({
    user_id: userId,
    insight_type: INSIGHT_TYPES.SKILL_DEMAND,
    source_engine: SOURCE_ENGINES.LABOR_MARKET,
    priority: 2,
    title: `${skill.skill || skill.name} demand is rising`,
    description: `Demand for ${skill.skill || skill.name} is increasing in the market.`,
    payload: skill,
  }));
}

function buildMarketTrendInsights(userId, careerTrends) {
  if (!Array.isArray(careerTrends)) return [];

  return careerTrends.slice(0, 2).map((trend) => ({
    user_id: userId,
    insight_type: INSIGHT_TYPES.MARKET_TREND,
    source_engine: SOURCE_ENGINES.LABOR_MARKET,
    priority: 3,
    title: `${trend.role || trend.career} is trending`,
    description: 'Career demand is rising in this area.',
    payload: trend,
  }));
}

function buildOpportunityInsights(userId, radarData) {
  if (!Array.isArray(radarData?.opportunities)) return [];

  return radarData.opportunities.slice(0, 2).map((opp) => ({
    user_id: userId,
    insight_type: INSIGHT_TYPES.OPPORTUNITY_SIGNAL,
    source_engine: SOURCE_ENGINES.OPPORTUNITY_RADAR,
    priority: 2,
    title: `New opportunity: ${opp.role}`,
    description: 'Opportunity detected for your profile.',
    payload: opp,
  }));
}

function buildJobMatchInsights(userId, matchData) {
  if (!Array.isArray(matchData?.matches)) return [];

  return matchData.matches.slice(0, 2).map((match) => ({
    user_id: userId,
    insight_type: INSIGHT_TYPES.JOB_MATCH,
    source_engine: SOURCE_ENGINES.JOB_MATCHING,
    priority: 2,
    title: `Job match: ${match.title}`,
    description: 'A matching job is available.',
    payload: match,
  }));
}

function buildRiskInsights(userId, riskData) {
  if (!riskData || riskData.overall_risk_score < 50) return [];

  return [
    {
      user_id: userId,
      insight_type: INSIGHT_TYPES.RISK_ALERT,
      source_engine: SOURCE_ENGINES.CAREER_RISK_PREDICTOR,
      priority: 1,
      title: 'Career risk alert',
      description: `Risk score: ${riskData.overall_risk_score}`,
      payload: riskData,
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Main service
// ─────────────────────────────────────────────────────────────────────────────

async function generateInsightsForUser(userId) {
  const todayCount = await repo.countTodayInsights(userId);

  if (todayCount >= DAILY_INSIGHT_LIMIT) {
    return [];
  }

  const remaining = DAILY_INSIGHT_LIMIT - todayCount;

  const [skillDemand, trends, radar, matches, risk] =
    await Promise.all([
      readSkillDemand(),
      readCareerTrends(),
      readOpportunityRadar(userId),
      readJobMatches(userId),
      readCareerRisk(userId),
    ]);

  const insights = [
    ...buildSkillDemandInsights(userId, skillDemand),
    ...buildMarketTrendInsights(userId, trends),
    ...buildOpportunityInsights(userId, radar),
    ...buildJobMatchInsights(userId, matches),
    ...buildRiskInsights(userId, risk),
  ].slice(0, remaining);

  if (insights.length === 0) {
    return [];
  }

  const inserted = await repo.insertInsightsBatch(insights);

  await cacheDel(CacheKeys.insights(userId));

  return inserted;
}

async function getInsightsFeed(userId, opts = {}) {
  const isDefault =
    !opts.unreadOnly &&
    !opts.insightType &&
    !opts.offset;

  const cacheKey = CacheKeys.insights(userId);

  if (isDefault) {
    const cached = await cacheGet(cacheKey);
    if (cached) {
      return { ...cached, cached: true };
    }
  }

  const insights = await repo.getUserInsights(userId, opts);

  const result = {
    insights,
    unread_count: insights.filter((i) => !i.is_read).length,
    cached: false,
  };

  if (isDefault) {
    await cacheSet(cacheKey, result);
  }

  return result;
}

async function markInsightsRead(userId, ids = []) {
  const updated = await repo.markInsightsRead(userId, ids);

  await cacheDel(CacheKeys.insights(userId));

  return { updated };
}

module.exports = {
  generateInsightsForUser,
  getInsightsFeed,
  markInsightsRead,
};