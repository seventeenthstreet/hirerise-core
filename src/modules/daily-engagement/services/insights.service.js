'use strict';

const logger     = require('../../../utils/logger');
const supabase   = require('../../../config/supabase');
const cacheManager = require('../../../core/cache/cache.manager');

const repo = require('../models/engagement.repository');
const {
  INSIGHT_TYPES,
  SOURCE_ENGINES,
  CacheKeys,
  CACHE_TTL_SEC,
  DAILY_INSIGHT_LIMIT,
} = require('../models/engagement.constants');

// ─── Lazy-load LMI service ───────────────────────────────────────────────────

function getMarketTrend() {
  return require('../../labor-market-intelligence/services/marketTrend.service');
}

// ─── Redis helpers ───────────────────────────────────────────────────────────

async function _cacheGet(key) {
  try {
    const raw = await cacheManager.getClient().get(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function _cacheSet(key, value) {
  try {
    await cacheManager.getClient().set(key, JSON.stringify(value), CACHE_TTL_SEC);
  } catch {}
}

async function _cacheDel(key) {
  try { await cacheManager.getClient().delete(key); } catch {}
}

// ─── Engine output readers ───────────────────────────────────────────────────

async function _readSkillDemand() {
  try {
    const marketTrend = getMarketTrend();
    return await marketTrend.getSkillDemand() || [];
  } catch (err) {
    logger.warn('[InsightsService] LMI skill demand read failed', { err: err.message });
    return [];
  }
}

async function _readCareerTrends() {
  try {
    const marketTrend = getMarketTrend();
    return await marketTrend.getCareerTrends() || [];
  } catch (err) {
    logger.warn('[InsightsService] LMI career trends read failed', { err: err.message });
    return [];
  }
}

// ✅ FIXED: Supabase version
async function _readOpportunityRadar(userId) {
  try {
    const { data, error } = await supabase
      .from('career_opportunities')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw error;
    return data || null;

  } catch (err) {
    logger.warn('[InsightsService] OpportunityRadar read failed', { err: err.message, userId });
    return null;
  }
}

// ✅ FIXED: Supabase version
async function _readJobMatches(userId) {
  try {
    const { data, error } = await supabase
      .from('job_matches')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw error;
    return data || null;

  } catch (err) {
    logger.warn('[InsightsService] JobMatches read failed', { err: err.message, userId });
    return null;
  }
}

// ✅ FIXED: Supabase version
async function _readCareerRisk(userId) {
  try {
    const { data, error } = await supabase
      .from('career_risk')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw error;
    return data || null;

  } catch (err) {
    logger.warn('[InsightsService] CareerRisk read failed', { err: err.message, userId });
    return null;
  }
}

// ─── Insight builders (UNCHANGED) ───────────────────────────────────────────

function _buildSkillDemandInsights(userId, skillDemand) {
  if (!Array.isArray(skillDemand)) return [];

  return skillDemand.slice(0, 3).map(skill => ({
    user_id: userId,
    insight_type: INSIGHT_TYPES.SKILL_DEMAND,
    source_engine: SOURCE_ENGINES.LABOR_MARKET,
    priority: 2,
    title: `${skill.skill || skill.name} demand is rising`,
    description: `Demand for ${skill.skill || skill.name} is increasing in the market.`,
    payload: skill,
  }));
}

function _buildMarketTrendInsights(userId, careerTrends) {
  if (!Array.isArray(careerTrends)) return [];

  return careerTrends.slice(0, 2).map(trend => ({
    user_id: userId,
    insight_type: INSIGHT_TYPES.MARKET_TREND,
    source_engine: SOURCE_ENGINES.LABOR_MARKET,
    priority: 3,
    title: `${trend.role || trend.career} is trending`,
    description: `Career demand is rising in this area.`,
    payload: trend,
  }));
}

function _buildOpportunityInsights(userId, radarData) {
  if (!radarData?.opportunities) return [];

  return radarData.opportunities.slice(0, 2).map(opp => ({
    user_id: userId,
    insight_type: INSIGHT_TYPES.OPPORTUNITY_SIGNAL,
    source_engine: SOURCE_ENGINES.OPPORTUNITY_RADAR,
    priority: 2,
    title: `New opportunity: ${opp.role}`,
    description: `Opportunity detected for your profile.`,
    payload: opp,
  }));
}

function _buildJobMatchInsights(userId, matchData) {
  if (!matchData?.matches) return [];

  return matchData.matches.slice(0, 2).map(match => ({
    user_id: userId,
    insight_type: INSIGHT_TYPES.JOB_MATCH,
    source_engine: SOURCE_ENGINES.JOB_MATCHING,
    priority: 2,
    title: `Job match: ${match.title}`,
    description: `A matching job is available.`,
    payload: match,
  }));
}

function _buildRiskInsights(userId, riskData) {
  if (!riskData || riskData.overall_risk_score < 50) return [];

  return [{
    user_id: userId,
    insight_type: INSIGHT_TYPES.RISK_ALERT,
    source_engine: SOURCE_ENGINES.CAREER_RISK_PREDICTOR,
    priority: 1,
    title: 'Career risk alert',
    description: `Risk score: ${riskData.overall_risk_score}`,
    payload: riskData,
  }];
}

// ─── MAIN SERVICE ───────────────────────────────────────────────────────────

async function generateInsightsForUser(userId) {

  const todayCount = await repo.countTodayInsights(userId);
  if (todayCount >= DAILY_INSIGHT_LIMIT) return [];

  const remaining = DAILY_INSIGHT_LIMIT - todayCount;

  const [skillDemand, trends, radar, matches, risk] = await Promise.all([
    _readSkillDemand(),
    _readCareerTrends(),
    _readOpportunityRadar(userId),
    _readJobMatches(userId),
    _readCareerRisk(userId),
  ]);

  const insights = [
    ..._buildSkillDemandInsights(userId, skillDemand),
    ..._buildMarketTrendInsights(userId, trends),
    ..._buildOpportunityInsights(userId, radar),
    ..._buildJobMatchInsights(userId, matches),
    ..._buildRiskInsights(userId, risk),
  ].slice(0, remaining);

  const inserted = await repo.insertInsightsBatch(insights);

  await _cacheDel(CacheKeys.insights(userId));

  return inserted;
}

async function getInsightsFeed(userId, opts = {}) {

  const cacheKey = CacheKeys.insights(userId);
  const cached = await _cacheGet(cacheKey);

  if (cached) return { ...cached, cached: true };

  const insights = await repo.getUserInsights(userId, opts);

  const result = {
    insights,
    unread_count: insights.filter(i => !i.read).length,
  };

  await _cacheSet(cacheKey, result);

  return result;
}

async function markInsightsRead(userId, ids = []) {
  const updated = await repo.markInsightsRead(userId, ids);
  await _cacheDel(CacheKeys.insights(userId));
  return { updated };
}

module.exports = {
  generateInsightsForUser,
  getInsightsFeed,
  markInsightsRead,
};





