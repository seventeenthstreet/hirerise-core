'use strict';

/**
 * src/modules/labor-market-intelligence/processors/demandAnalysis.service.js
 *
 * Computes:
 * - skill demand scores
 * - career market scores
 * - salary benchmark projections
 *
 * Fully Supabase-optimized:
 * - row-based SQL reads
 * - bulk upserts
 * - reduced memory churn
 * - O(n) aggregation passes
 */

const { supabase } = require('../../../config/supabase');
const logger = require('../../../utils/logger');
const {
  COLLECTIONS,
  buildSkillDemandDoc,
  buildCareerScoreDoc
} = require('../models/jobMarket.model');
const {
  aggregateSkillCounts
} = require('./skillExtraction.service');

const UPSERT_CHUNK_SIZE = 500;
const MAX_SKILL_RESULTS = 50;

const TITLE_MAP = Object.freeze({
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
});

const AUTOMATION_RISK = Object.freeze({
  'Software Engineer': 15,
  'AI / ML Engineer': 8,
  'Data Scientist': 12,
  'Cybersecurity Specialist': 10,
  'Systems Architect': 18,
  'Doctor (MBBS / MD)': 5,
  'Biomedical Researcher': 12,
  Pharmacist: 45,
  'Chartered Accountant': 38,
  'Investment Banker': 30,
  Entrepreneur: 10,
  'Marketing Manager': 28,
  Lawyer: 22,
  'Journalist / Writer': 48,
  'UX Designer': 20,
  'Civil Services (IAS/IPS)': 5
});

// ───────────────────────────────────────────────────────────────────────────────
// Public API
// ───────────────────────────────────────────────────────────────────────────────

async function runFullAnalysis() {
  logger.info('[DemandAnalysis] Starting full analysis cycle');

  const jobs = await loadJobs();

  if (jobs.length === 0) {
    logger.warn('[DemandAnalysis] No job data found — run collector first');
    return { skills_updated: 0, careers_updated: 0 };
  }

  logger.info(
    { count: jobs.length },
    '[DemandAnalysis] Loaded job rows'
  );

  const [skillsUpdated, careersUpdated] = await Promise.all([
    analyseSkillDemand(jobs),
    analyseCareerDemand(jobs)
  ]);

  logger.info(
    { skillsUpdated, careersUpdated },
    '[DemandAnalysis] Analysis complete'
  );

  return {
    skills_updated: skillsUpdated,
    careers_updated: careersUpdated
  };
}

async function loadCareerScores() {
  const { data, error } = await supabase
    .from(COLLECTIONS.CAREER_SCORES)
    .select('*');

  if (error) {
    throw new Error(`[DemandAnalysis] Failed loading career scores: ${error.message}`);
  }

  return Object.fromEntries(
    (data || [])
      .filter((row) => row?.career_name)
      .map((row) => [row.career_name, row])
  );
}

async function loadSkillDemand() {
  const { data, error } = await supabase
    .from(COLLECTIONS.SKILL_DEMAND)
    .select('*')
    .order('demand_score', { ascending: false })
    .limit(MAX_SKILL_RESULTS);

  if (error) {
    throw new Error(`[DemandAnalysis] Failed loading skill demand: ${error.message}`);
  }

  return data || [];
}

// ───────────────────────────────────────────────────────────────────────────────
// Core Analysis
// ───────────────────────────────────────────────────────────────────────────────

async function analyseSkillDemand(jobs) {
  const skillCounts = aggregateSkillCounts(jobs);

  if (skillCounts.size === 0) {
    return 0;
  }

  const counts = [...skillCounts.values()];
  const maxCount = Math.max(...counts);
  const minCount = Math.min(...counts);
  const totalJobs = jobs.length;
  const updatedAt = new Date().toISOString();

  const skillIndustryMap = buildSkillIndustryMap(jobs);
  const rows = [];

  for (const [skill, count] of skillCounts.entries()) {
    rows.push({
      id: toDocId(skill),
      ...buildSkillDemandDoc({
        skill_name: skill,
        demand_score: normalise(count, maxCount, minCount),
        growth_rate: clamp(count / totalJobs, 0, 1),
        industry_usage: skillIndustryMap.get(skill) || [],
        job_count: count
      }),
      updated_at: updatedAt
    });
  }

  await bulkUpsert(COLLECTIONS.SKILL_DEMAND, rows);
  return rows.length;
}

async function analyseCareerDemand(jobs) {
  const careerGroups = groupJobsByCareer(jobs);

  if (careerGroups.size === 0) {
    return 0;
  }

  const counts = [...careerGroups.values()].map((rows) => rows.length);
  const maxCount = Math.max(...counts);
  const minCount = Math.min(...counts);
  const updatedAt = new Date().toISOString();

  const rows = [];

  for (const [career, careerJobs] of careerGroups.entries()) {
    const count = careerJobs.length;
    const avgSalary = calculateAverageSalary(careerJobs);

    const growthRate = 0.12 + count / (maxCount * 5);
    const salaryGrowth = clamp(growthRate, 0, 1);
    const avg5yrSalary = Math.round(avgSalary * Math.pow(1 + salaryGrowth, 4));
    const avg10yrSalary = Math.round(avgSalary * Math.pow(1 + salaryGrowth, 9));

    const demandScore = normalise(count, maxCount, minCount);
    const automationRisk = AUTOMATION_RISK[career] ?? 30;

    const trendScore = Math.round(
      demandScore * 0.5 +
      (1 - automationRisk / 100) * 100 * 0.3 +
      clamp((salaryGrowth / 0.3) * 100, 0, 100) * 0.2
    );

    const topSkills = getTopSkills(careerJobs);

    rows.push({
      id: toDocId(career),
      ...buildCareerScoreDoc({
        career_name: career,
        demand_score: demandScore,
        salary_growth: salaryGrowth,
        automation_risk: automationRisk,
        trend_score: trendScore,
        avg_entry_salary: avgSalary,
        avg_5yr_salary: avg5yrSalary,
        avg_10yr_salary: avg10yrSalary,
        top_skills: topSkills
      }),
      updated_at: updatedAt
    });
  }

  await bulkUpsert(COLLECTIONS.CAREER_SCORES, rows);
  return rows.length;
}

// ───────────────────────────────────────────────────────────────────────────────
// DB Helpers
// ───────────────────────────────────────────────────────────────────────────────

async function loadJobs() {
  const { data, error } = await supabase
    .from(COLLECTIONS.JOB_MARKET)
    .select(`
      job_title,
      salary_min,
      salary_max,
      skills,
      industry
    `);

  if (error) {
    throw new Error(`[DemandAnalysis] Failed loading jobs: ${error.message}`);
  }

  return data || [];
}

async function bulkUpsert(table, rows) {
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK_SIZE);

    const { error } = await supabase
      .from(table)
      .upsert(chunk);

    if (error) {
      throw new Error(`[DemandAnalysis] Upsert failed for ${table}: ${error.message}`);
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Pure Helpers
// ───────────────────────────────────────────────────────────────────────────────

function groupJobsByCareer(jobs) {
  const groups = new Map();

  for (const job of jobs) {
    const rawTitle = String(job?.job_title || '')
      .trim()
      .toLowerCase();

    const canonical = TITLE_MAP[rawTitle];
    if (!canonical) continue;

    if (!groups.has(canonical)) {
      groups.set(canonical, []);
    }

    groups.get(canonical).push(job);
  }

  return groups;
}

function buildSkillIndustryMap(jobs) {
  const map = new Map();

  for (const job of jobs) {
    const skills = Array.isArray(job?.skills) ? job.skills : [];
    const industry = job?.industry;

    for (const rawSkill of skills) {
      const skill = String(rawSkill || '').trim();
      if (!skill) continue;

      if (!map.has(skill)) {
        map.set(skill, new Set());
      }

      if (industry) {
        map.get(skill).add(industry);
      }
    }
  }

  const normalized = new Map();

  for (const [skill, industries] of map.entries()) {
    normalized.set(skill, [...industries].slice(0, 5));
  }

  return normalized;
}

function calculateAverageSalary(jobs) {
  const salaries = jobs
    .map((job) => {
      const min = Number(job?.salary_min) || 0;
      const max = Number(job?.salary_max) || 0;
      const avg = (min + max) / 2;
      return avg > 0 ? avg : null;
    })
    .filter(Boolean);

  if (salaries.length === 0) {
    return 0;
  }

  return Math.round(
    salaries.reduce((sum, value) => sum + value, 0) / salaries.length
  );
}

function getTopSkills(jobs) {
  const skillMap = aggregateSkillCounts(jobs);

  return [...skillMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([skill]) => skill);
}

function normalise(value, max, min = 0) {
  if (max === min) return 50;
  return Math.round(((value - min) / (max - min)) * 100);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toDocId(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_');
}

module.exports = {
  runFullAnalysis,
  loadCareerScores,
  loadSkillDemand,
  TITLE_MAP
};