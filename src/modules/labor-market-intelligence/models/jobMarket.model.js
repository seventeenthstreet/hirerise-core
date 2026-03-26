'use strict';

/**
 * models/jobMarket.model.js
 *
 * Firestore collection names and document shape builders for the
 * Labor Market Intelligence module.
 *
 * Collections (all prefixed lmi_ to stay isolated):
 *   lmi_job_market_data     — raw job postings (real or mock)
 *   lmi_skill_demand        — aggregated skill demand scores
 *   lmi_career_market_scores — per-career market intelligence scores
 *   lmi_ingestion_runs      — audit log of collector runs
 */

const COLLECTIONS = {
  JOB_MARKET:     'lmi_job_market_data',
  SKILL_DEMAND:   'lmi_skill_demand',
  CAREER_SCORES:  'lmi_career_market_scores',
  INGESTION_RUNS: 'lmi_ingestion_runs',
};

// ─── Document builders ────────────────────────────────────────────────────────

/**
 * lmi_job_market_data/{autoId}
 *
 *   job_title    — string
 *   company      — string
 *   location     — string
 *   salary_min   — number (INR annual)
 *   salary_max   — number (INR annual)
 *   skills       — string[]
 *   industry     — string
 *   source       — 'linkedin' | 'indeed' | 'naukri' | 'mock'
 *   posting_date — ISO date string
 *   created_at   — serverTimestamp
 */
function buildJobDoc(fields) {
  return {
    job_title:    fields.job_title    || null,
    company:      fields.company      || null,
    location:     fields.location     || null,
    salary_min:   fields.salary_min   != null ? Number(fields.salary_min)  : null,
    salary_max:   fields.salary_max   != null ? Number(fields.salary_max)  : null,
    skills:       Array.isArray(fields.skills) ? fields.skills : [],
    industry:     fields.industry     || null,
    source:       fields.source       || 'mock',
    posting_date: fields.posting_date || new Date().toISOString().slice(0, 10),
    created_at:   null,
  };
}

/**
 * lmi_skill_demand/{skill_name}  (doc ID = normalised skill name)
 *
 *   skill_name     — string
 *   demand_score   — number 0–100
 *   growth_rate    — number (YoY %, e.g. 0.15 = 15%)
 *   industry_usage — string[] — industries where skill is in demand
 *   job_count      — number  — raw posting count driving the score
 *   updated_at     — serverTimestamp
 */
function buildSkillDemandDoc(fields) {
  return {
    skill_name:     fields.skill_name     || null,
    demand_score:   fields.demand_score   != null ? Number(fields.demand_score)  : 0,
    growth_rate:    fields.growth_rate    != null ? Number(fields.growth_rate)   : 0,
    industry_usage: Array.isArray(fields.industry_usage) ? fields.industry_usage : [],
    job_count:      fields.job_count      != null ? Number(fields.job_count)     : 0,
    updated_at:     null,
  };
}

/**
 * lmi_career_market_scores/{career_name}  (doc ID = career name)
 *
 *   career_name       — string
 *   demand_score      — number 0–100
 *   salary_growth     — number (YoY %, e.g. 0.12 = 12%)
 *   automation_risk   — number 0–100 (higher = more at risk)
 *   trend_score       — number 0–100  (composite market signal)
 *   avg_entry_salary  — number (INR)
 *   avg_5yr_salary    — number (INR)
 *   avg_10yr_salary   — number (INR)
 *   top_skills        — string[]
 *   updated_at        — serverTimestamp
 */
function buildCareerScoreDoc(fields) {
  return {
    career_name:      fields.career_name      || null,
    demand_score:     fields.demand_score     != null ? Number(fields.demand_score)    : 0,
    salary_growth:    fields.salary_growth    != null ? Number(fields.salary_growth)   : 0,
    automation_risk:  fields.automation_risk  != null ? Number(fields.automation_risk) : 0,
    trend_score:      fields.trend_score      != null ? Number(fields.trend_score)     : 0,
    avg_entry_salary: fields.avg_entry_salary != null ? Number(fields.avg_entry_salary) : null,
    avg_5yr_salary:   fields.avg_5yr_salary   != null ? Number(fields.avg_5yr_salary)   : null,
    avg_10yr_salary:  fields.avg_10yr_salary  != null ? Number(fields.avg_10yr_salary)  : null,
    top_skills:       Array.isArray(fields.top_skills) ? fields.top_skills : [],
    updated_at:       null,
  };
}

module.exports = {
  COLLECTIONS,
  buildJobDoc,
  buildSkillDemandDoc,
  buildCareerScoreDoc,
};









