'use strict';

/**
 * src/modules/labor-market-intelligence/services/marketTrend.service.js
 *
 * Public facade + orchestration layer for Labor Market Intelligence.
 *
 * Responsibilities:
 * - read APIs with cache
 * - full refresh orchestration
 * - static fallbacks before first ingestion
 * - orchestrator-friendly market score access
 *
 * DB: lmi_career_market_scores (Supabase/PostgreSQL)
 * Indexes:
 *   - idx_lmi_career_scores_trend_score  ON (trend_score DESC)
 *   - idx_lmi_career_scores_salary       ON (avg_entry_salary DESC)
 * Trigger:
 *   - trg_lmi_career_scores_updated_at  auto-stamps updated_at on UPDATE
 */

const logger = require('../../../utils/logger');
const { supabase } = require('../../../config/supabase');

const jobCollector = require('../collectors/jobCollector.service');
const demandAnalysis = require('../processors/demandAnalysis.service');

const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_TTL_MS = normalizePositiveInt(
  process.env.LMI_CACHE_TTL_MS,
  DEFAULT_CACHE_TTL_MS
);

// ───────────────────────────────────────────────────────────────────────────────
// Table Reference
//
// Hardcoded directly after migration confirmed lmi_career_market_scores is the
// correct table. Removes runtime dependency on COLLECTIONS.CAREER_SCORES from
// jobMarket.model — which previously resolved to a non-existent table, causing
// getCareerTrends() and getSalaryBenchmarks() to silently fall back to static
// data on every call.
// ───────────────────────────────────────────────────────────────────────────────

const TABLE_CAREER_SCORES = 'lmi_career_market_scores';

// ───────────────────────────────────────────────────────────────────────────────
// Cache
// ───────────────────────────────────────────────────────────────────────────────

const cache = {
  careerTrends: createCacheEntry(),
  skillDemand: createCacheEntry(),
  salaryBenchmarks: createCacheEntry()
};

function createCacheEntry() {
  return {
    value: null,
    lastRefreshed: 0
  };
}

function isFresh(entry) {
  return (
    entry.lastRefreshed > 0 &&
    Date.now() - entry.lastRefreshed < CACHE_TTL_MS
  );
}

function setCache(entry, value) {
  entry.value = value;
  entry.lastRefreshed = Date.now();
}

function invalidateCache() {
  Object.values(cache).forEach((entry) => {
    entry.value = null;
    entry.lastRefreshed = 0;
  });
}

// ───────────────────────────────────────────────────────────────────────────────
// Refresh Pipeline
// ───────────────────────────────────────────────────────────────────────────────

async function runRefresh({ batchSize = 50 } = {}) {
  logger.info(
    { batchSize },
    '[MarketTrend] Starting full LMI refresh'
  );

  const collectResult = await jobCollector.collect({ batchSize });
  const analysisResult = await demandAnalysis.runFullAnalysis();

  invalidateCache();

  const result = {
    ...collectResult,
    ...analysisResult
  };

  logger.info(result, '[MarketTrend] Refresh complete');

  return result;
}

// ───────────────────────────────────────────────────────────────────────────────
// Read APIs
// ───────────────────────────────────────────────────────────────────────────────

async function getCareerTrends() {
  const entry = cache.careerTrends;

  if (isFresh(entry) && entry.value) {
    return entry.value;
  }

  const { data, error } = await supabase
    .from(TABLE_CAREER_SCORES)
    .select(`
      career_name,
      demand_score,
      trend_score,
      automation_risk,
      salary_growth,
      top_skills
    `)
    .order('trend_score', { ascending: false });

  if (error) {
    logger.error('[MarketTrend] Failed loading career trends, using static fallback', {
      table: TABLE_CAREER_SCORES,
      error: error.message
    });
    return STATIC_CAREER_TRENDS;
  }

  const result = data?.length ? data : STATIC_CAREER_TRENDS;

  setCache(entry, result);
  return result;
}

async function getSkillDemand(limit = 20) {
  const entry = cache.skillDemand;

  if (isFresh(entry) && entry.value) {
    return entry.value.slice(0, limit);
  }

  const result = await demandAnalysis.loadSkillDemand();
  const data = result.length ? result : STATIC_SKILL_DEMAND;

  setCache(entry, data);
  return data.slice(0, limit);
}

async function getSalaryBenchmarks() {
  const entry = cache.salaryBenchmarks;

  if (isFresh(entry) && entry.value) {
    return entry.value;
  }

  const { data, error } = await supabase
    .from(TABLE_CAREER_SCORES)
    .select(`
      career_name,
      avg_entry_salary,
      avg_5yr_salary,
      avg_10yr_salary,
      salary_growth
    `)
    .order('avg_entry_salary', { ascending: false });

  if (error) {
    logger.error('[MarketTrend] Failed loading salary benchmarks, using static fallback', {
      table: TABLE_CAREER_SCORES,
      error: error.message
    });
    return STATIC_SALARY_BENCHMARKS;
  }

  const result = (data || [])
    .filter((row) => row?.career_name && row?.avg_entry_salary);

  const finalData = result.length
    ? result
    : STATIC_SALARY_BENCHMARKS;

  setCache(entry, finalData);
  return finalData;
}

async function getCareerScoresMap() {
  const scores = await demandAnalysis.loadCareerScores();

  if (Object.keys(scores).length > 0) {
    return scores;
  }

  return Object.fromEntries(
    STATIC_CAREER_TRENDS.map((career) => [
      career.career_name,
      career
    ])
  );
}

// ───────────────────────────────────────────────────────────────────────────────
// Static Fallbacks
// Used when: DB is unreachable, query errors, or table returns empty rows.
// Kept in sync with seed data in lmi_career_market_scores.
// ───────────────────────────────────────────────────────────────────────────────

const STATIC_CAREER_TRENDS = Object.freeze([
  {
    career_name: 'AI / ML Engineer',
    demand_score: 98,
    trend_score: 96,
    automation_risk: 8,
    salary_growth: 0.17,
    top_skills: ['Python', 'TensorFlow', 'PyTorch', 'NLP', 'Machine Learning']
  },
  {
    career_name: 'Software Engineer',
    demand_score: 95,
    trend_score: 92,
    automation_risk: 15,
    salary_growth: 0.14,
    top_skills: ['Python', 'JavaScript', 'AWS', 'System Design', 'SQL']
  },
  {
    career_name: 'Data Scientist',
    demand_score: 93,
    trend_score: 90,
    automation_risk: 12,
    salary_growth: 0.15,
    top_skills: ['Python', 'R', 'Machine Learning', 'SQL', 'Statistics']
  },
  {
    career_name: 'Cybersecurity Specialist',
    demand_score: 91,
    trend_score: 88,
    automation_risk: 10,
    salary_growth: 0.14,
    top_skills: ['Network Security', 'Python', 'SIEM', 'Ethical Hacking']
  },
  {
    career_name: 'Systems Architect',
    demand_score: 88,
    trend_score: 84,
    automation_risk: 18,
    salary_growth: 0.13,
    top_skills: ['AWS', 'Kubernetes', 'System Design', 'Docker', 'Terraform']
  }
]);

const STATIC_SKILL_DEMAND = Object.freeze([
  {
    skill_name: 'Python',
    demand_score: 98,
    growth_rate: 0.22,
    industry_usage: ['Technology', 'Finance', 'Healthcare']
  },
  {
    skill_name: 'Machine Learning',
    demand_score: 96,
    growth_rate: 0.25,
    industry_usage: ['Technology', 'Finance']
  },
  {
    skill_name: 'AWS',
    demand_score: 94,
    growth_rate: 0.2,
    industry_usage: ['Technology']
  }
]);

const STATIC_SALARY_BENCHMARKS = Object.freeze([
  {
    career_name: 'AI / ML Engineer',
    avg_entry_salary: 750000,
    avg_5yr_salary: 1650000,
    avg_10yr_salary: 3600000,
    salary_growth: 0.17
  },
  {
    career_name: 'Systems Architect',
    avg_entry_salary: 800000,
    avg_5yr_salary: 1520000,
    avg_10yr_salary: 2800000,
    salary_growth: 0.13
  }
]);

// ───────────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────────

function normalizePositiveInt(value, fallback) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

module.exports = Object.freeze({
  runRefresh,
  getCareerTrends,
  getSkillDemand,
  getSalaryBenchmarks,
  getCareerScoresMap,
  invalidateCache
});