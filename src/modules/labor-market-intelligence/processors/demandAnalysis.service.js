'use strict';

/**
 * processors/demandAnalysis.service.js
 *
 * Analyses job market data to compute:
 *   - Skill demand scores (0–100)
 *   - Career demand scores (0–100)
 *   - Salary benchmarks per career
 *
 * Reads from:  lmi_job_market_data (Supabase)
 * Writes to:   lmi_skill_demand, lmi_career_market_scores (Supabase)
 *
 * Called by:   marketTrend.service.js → full refresh cycle
 *              market.controller.js   → POST /api/v1/market/refresh
 */
const supabase = require('../../../config/supabase');
const logger = require('../../../utils/logger');
const {
  COLLECTIONS,
  buildSkillDemandDoc,
  buildCareerScoreDoc
} = require('../models/jobMarket.model');
const {
  aggregateSkillCounts
} = require('./skillExtraction.service');

// ─── Career title normalisation ───────────────────────────────────────────────
// Maps raw job titles from postings → canonical career names used by CSPE/CDTE

const TITLE_MAP = {
  'software engineer': 'Software Engineer',
  'senior software engineer': 'Software Engineer',
  'software developer': 'Software Engineer',
  'ai / ml engineer': 'AI / ML Engineer',
  'machine learning engineer': 'AI / ML Engineer',
  'ai engineer': 'AI / ML Engineer',
  'data scientist': 'Data Scientist',
  'data engineer': 'Data Scientist',
  'cybersecurity analyst': 'Cybersecurity Specialist',
  'cloud architect': 'Systems Architect',
  'devops engineer': 'Systems Architect',
  'investment banker': 'Investment Banker',
  'financial analyst': 'Investment Banker',
  'chartered accountant': 'Chartered Accountant',
  'marketing manager': 'Marketing Manager',
  'business analyst': 'Marketing Manager',
  'product manager': 'Entrepreneur',
  'medical officer': 'Doctor (MBBS / MD)',
  'biomedical engineer': 'Biomedical Researcher',
  'clinical research assoc.': 'Biomedical Researcher',
  'corporate lawyer': 'Lawyer',
  'ux designer': 'UX Designer',
  'content strategist': 'Journalist / Writer'
};

// Automation risk estimates per career (0–100, higher = more at risk)
const AUTOMATION_RISK = {
  'Software Engineer': 15,
  'AI / ML Engineer': 8,
  'Data Scientist': 12,
  'Cybersecurity Specialist': 10,
  'Systems Architect': 18,
  'Doctor (MBBS / MD)': 5,
  'Biomedical Researcher': 12,
  'Pharmacist': 45,
  'Chartered Accountant': 38,
  'Investment Banker': 30,
  'Entrepreneur': 10,
  'Marketing Manager': 28,
  'Lawyer': 22,
  'Journalist / Writer': 48,
  'UX Designer': 20,
  'Civil Services (IAS/IPS)': 5
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _normalise(value, max, min = 0) {
  if (max === min) return 50;
  return Math.round((value - min) / (max - min) * 100);
}

function _clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

// ─── Core analysis ────────────────────────────────────────────────────────────

/**
 * Full demand analysis cycle:
 *   1. Load all job market docs from Supabase
 *   2. Compute skill demand scores
 *   3. Compute career demand + salary benchmarks
 *   4. Persist results
 *
 * @returns {{ skills_updated: number, careers_updated: number }}
 */
async function runFullAnalysis() {
  logger.info('[DemandAnalysis] Starting full analysis cycle');

  // ── Load job data ─────────────────────────────────────────────────────
  const { data: jobs, error } = await supabase
    .from(COLLECTIONS.JOB_MARKET)
    .select('*');

  if (error) throw error;

  if (!jobs || jobs.length === 0) {
    logger.warn('[DemandAnalysis] No job data found — run collector first');
    return { skills_updated: 0, careers_updated: 0 };
  }

  logger.info({ count: jobs.length }, '[DemandAnalysis] Loaded job docs');

  // ── Skill demand ──────────────────────────────────────────────────────
  const skillsUpdated = await _analyseSkillDemand(jobs);

  // ── Career demand + salaries ──────────────────────────────────────────
  const careersUpdated = await _analyseCareerDemand(jobs);

  logger.info({ skillsUpdated, careersUpdated }, '[DemandAnalysis] Analysis complete');
  return { skills_updated: skillsUpdated, careers_updated: careersUpdated };
}

// ─── Skill demand ─────────────────────────────────────────────────────────────

async function _analyseSkillDemand(jobs) {
  const skillCounts = aggregateSkillCounts(jobs);
  if (skillCounts.size === 0) return 0;

  const maxCount = Math.max(...skillCounts.values());
  const minCount = Math.min(...skillCounts.values());

  // Estimate growth_rate from posting recency (recent = high growth proxy)
  // For mock data we use count share as a growth proxy
  const totalJobs = jobs.length;
  const rows = [];

  for (const [skill, count] of skillCounts.entries()) {
    const demand_score = _normalise(count, maxCount, minCount);
    const growth_rate = _clamp(count / totalJobs, 0, 1);

    // Derive industries from jobs that list this skill
    const industries = [
      ...new Set(
        jobs
          .filter(j => (j.skills ?? []).some(s => s.toLowerCase() === skill.toLowerCase()))
          .map(j => j.industry)
          .filter(Boolean)
      )
    ].slice(0, 5);

    const docId = skill.toLowerCase().replace(/[^a-z0-9]/g, '_');
    rows.push({
      id: docId,
      ...buildSkillDemandDoc({
        skill_name: skill,
        demand_score,
        growth_rate,
        industry_usage: industries,
        job_count: count
      }),
      updated_at: new Date().toISOString()
    });
  }

  const { error } = await supabase
    .from(COLLECTIONS.SKILL_DEMAND)
    .upsert(rows);

  if (error) throw error;
  return rows.length;
}

// ─── Career demand ────────────────────────────────────────────────────────────

async function _analyseCareerDemand(jobs) {
  // Group jobs by normalised career
  const careerGroups = new Map();
  for (const job of jobs) {
    const rawTitle = (job.job_title ?? '').toLowerCase().trim();
    const canonical = TITLE_MAP[rawTitle] ?? null;
    if (!canonical) continue;
    if (!careerGroups.has(canonical)) careerGroups.set(canonical, []);
    careerGroups.get(canonical).push(job);
  }

  if (careerGroups.size === 0) return 0;

  const maxCount = Math.max(...[...careerGroups.values()].map(g => g.length));
  const minCount = Math.min(...[...careerGroups.values()].map(g => g.length));
  const rows = [];

  for (const [career, careerJobs] of careerGroups.entries()) {
    const count = careerJobs.length;

    // ── Salary benchmarks ─────────────────────────────────────────────
    const salaries = careerJobs
      .map(j => (j.salary_min ?? 0 + j.salary_max ?? 0) / 2)
      .filter(s => s > 0);
    const avgSalary = salaries.length
      ? Math.round(salaries.reduce((a, b) => a + b, 0) / salaries.length)
      : 0;

    // Simple projection (mirrors Digital Twin engine logic)
    const growthRate = 0.12 + count / (maxCount * 5); // 12–32% range
    const avg5yrSalary = Math.round(avgSalary * Math.pow(1 + growthRate, 4));
    const avg10yrSalary = Math.round(avgSalary * Math.pow(1 + growthRate, 9));

    // ── Scores ────────────────────────────────────────────────────────
    const demand_score = _normalise(count, maxCount, minCount);
    const salary_growth = _clamp(growthRate, 0, 1);
    const automation_risk = AUTOMATION_RISK[career] ?? 30;

    // Trend score: weighted combination
    const trend_score = Math.round(
      demand_score * 0.5 +
      (1 - automation_risk / 100) * 100 * 0.3 +
      _clamp(salary_growth / 0.3 * 100, 0, 100) * 0.2
    );

    // Top skills for this career
    const skillMap = aggregateSkillCounts(careerJobs);
    const topSkills = [...skillMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([s]) => s);

    const docId = career.toLowerCase().replace(/[^a-z0-9]/g, '_');
    rows.push({
      id: docId,
      ...buildCareerScoreDoc({
        career_name: career,
        demand_score,
        salary_growth,
        automation_risk,
        trend_score,
        avg_entry_salary: avgSalary,
        avg_5yr_salary: avg5yrSalary,
        avg_10yr_salary: avg10yrSalary,
        top_skills: topSkills
      }),
      updated_at: new Date().toISOString()
    });
  }

  const { error } = await supabase
    .from(COLLECTIONS.CAREER_SCORES)
    .upsert(rows);

  if (error) throw error;
  return rows.length;
}

/**
 * Load all career market scores as a plain object keyed by career name.
 * Used by the orchestrator to inject live market signals into engines.
 *
 * @returns {Promise<Record<string, CareerMarketScore>>}
 */
async function loadCareerScores() {
  const { data, error } = await supabase
    .from(COLLECTIONS.CAREER_SCORES)
    .select('*');

  if (error) throw error;

  const result = {};
  for (const row of (data ?? [])) {
    if (row.career_name) result[row.career_name] = row;
  }
  return result;
}

/**
 * Load all skill demand scores as an array, sorted by demand_score desc.
 *
 * @returns {Promise<SkillDemandDoc[]>}
 */
async function loadSkillDemand() {
  const { data, error } = await supabase
    .from(COLLECTIONS.SKILL_DEMAND)
    .select('*')
    .order('demand_score', { ascending: false })
    .limit(50);

  if (error) throw error;
  return data ?? [];
}

module.exports = {
  runFullAnalysis,
  loadCareerScores,
  loadSkillDemand,
  TITLE_MAP
};