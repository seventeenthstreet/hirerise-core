'use strict';

/**
 * src/modules/labor-market-intelligence/models/jobMarket.model.js
 *
 * Canonical SQL table registry + row builders for
 * Labor Market Intelligence (LMI).
 *
 * This file is the single source of truth for:
 * - Supabase table names
 * - insert/upsert row normalization
 * - analytics-safe field coercion
 *
 * IMPORTANT:
 * Keep CAREER_SCORES aligned with:
 *   lmi_career_market_scores
 * to prevent fallback-only reads in marketTrend.service.js
 */

const TABLES = Object.freeze({
  JOB_MARKET: 'lmi_job_market_data',
  SKILL_DEMAND: 'lmi_skill_demand',
  CAREER_SCORES: 'lmi_career_market_scores',
  INGESTION_RUNS: 'lmi_ingestion_runs'
});

/**
 * Backward-compatible alias export.
 * Preserved so existing imports do not break.
 */
const COLLECTIONS = TABLES;

// ───────────────────────────────────────────────────────────────────────────────
// SQL Row Builders
// ───────────────────────────────────────────────────────────────────────────────

function buildJobDoc(fields = {}) {
  const salaryMin = toNullableNumber(fields.salary_min);
  const salaryMax = toNullableNumber(fields.salary_max);

  return {
    job_title: toNullableString(fields.job_title),
    company: toNullableString(fields.company),
    location: toNullableString(fields.location),
    salary_min: salaryMin,
    salary_max:
      salaryMax != null
        ? Math.max(salaryMax, salaryMin ?? salaryMax)
        : salaryMax,
    skills: toStringArray(fields.skills),
    industry: toNullableString(fields.industry),
    source: toNullableString(fields.source) || 'mock',
    posting_date: normalizeDate(fields.posting_date)
  };
}

function buildSkillDemandDoc(fields = {}) {
  return {
    skill_name: toNullableString(fields.skill_name),
    demand_score: clampNumber(toSafeNumber(fields.demand_score, 0), 0, 100),
    growth_rate: clampNumber(toSafeNumber(fields.growth_rate, 0), 0, 1),
    industry_usage: toStringArray(fields.industry_usage),
    job_count: Math.max(0, toSafeInteger(fields.job_count, 0))
  };
}

function buildCareerScoreDoc(fields = {}) {
  return {
    career_name: toNullableString(fields.career_name),
    demand_score: clampNumber(toSafeNumber(fields.demand_score, 0), 0, 100),
    salary_growth: clampNumber(toSafeNumber(fields.salary_growth, 0), 0, 1),
    automation_risk: clampNumber(toSafeNumber(fields.automation_risk, 0), 0, 100),
    trend_score: clampNumber(toSafeNumber(fields.trend_score, 0), 0, 100),
    avg_entry_salary: toNullablePositiveNumber(fields.avg_entry_salary),
    avg_5yr_salary: toNullablePositiveNumber(fields.avg_5yr_salary),
    avg_10yr_salary: toNullablePositiveNumber(fields.avg_10yr_salary),
    top_skills: toStringArray(fields.top_skills)
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// Normalization Helpers
// ───────────────────────────────────────────────────────────────────────────────

function toNullableString(value) {
  if (typeof value !== 'string') {
    return value == null ? null : String(value).trim() || null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function toNullableNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toNullablePositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function toSafeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toSafeInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

function toStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(
    value
      .map((item) => toNullableString(item))
      .filter(Boolean)
  )];
}

function normalizeDate(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
      return trimmed.slice(0, 10);
    }
  }

  return new Date().toISOString().slice(0, 10);
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

module.exports = Object.freeze({
  TABLES,
  COLLECTIONS,
  buildJobDoc,
  buildSkillDemandDoc,
  buildCareerScoreDoc
});