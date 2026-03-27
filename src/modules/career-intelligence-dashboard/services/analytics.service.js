'use strict';

/**
 * services/analytics.service.js
 *
 * Global Career Intelligence Dashboard — Analytics Aggregation Service
 *
 * Responsibilities:
 *   - Aggregate data from LMI, Skill Evolution Engine, Education ROI engine,
 *     Career Graph, and student outcomes into five macro-level metrics.
 *   - Cache computed results in Supabase (gcid_aggregated_cache).
 *   - Store historical snapshots in gcid_analytics_snapshots for trend lines.
 *   - Expose read methods consumed by analytics.controller.js.
 *
 * Five metrics:
 *   1. Career Demand Index    — ranked careers by demand + salary growth signals
 *   2. Skill Demand Index     — ranked skills by market demand + growth velocity
 *   3. Education ROI Index    — ranked education paths by ROI score
 *   4. Career Growth Forecast — 10-year salary trajectory per top career
 *   5. Industry Trend Analysis — emerging sectors by growth signal
 *
 * Data sources (all via existing platform services — no new external calls):
 *   - marketTrend.service  → LMI career scores + skill demand
 *   - Static enrichment datasets (curated below) for salary benchmarks,
 *     education ROI, and industry signals — same approach as LMI static fallbacks
 *   - edu_career_predictions (Supabase) → aggregated student outcomes
 *   - edu_education_roi (Supabase) → ROI data from student analyses
 */
const logger = require('../../../utils/logger');
const supabase = require('../../../core/supabaseClient');
const marketTrend = require('../../labor-market-intelligence/services/marketTrend.service');
const {
  COLLECTIONS,
  METRIC_NAMES,
  buildSnapshotDoc,
  buildCacheDoc
} = require('../models/analyticsSnapshot.model');

// ─── In-memory cache (avoids Supabase reads on every API hit) ─────────────────

const _memCache = {};
const MEM_TTL_MS = 10 * 60 * 1000; // 10 minutes

function _memGet(key) {
  const entry = _memCache[key];
  if (!entry) return null;
  if (Date.now() - entry.ts > MEM_TTL_MS) return null;
  return entry.value;
}
function _memSet(key, value) {
  _memCache[key] = { value, ts: Date.now() };
}

// ─── Static enrichment datasets ───────────────────────────────────────────────
// These mirror the static fallbacks in marketTrend.service.js but are
// curated specifically for the GCID macro-level perspective.

const CAREER_BENCHMARKS = {
  'AI / ML Engineer':           { demand: 98, trend: 96, salary_growth: 0.17, entry: 750000,  y10: 3600000, automation_risk: 8  },
  'Software Engineer':          { demand: 95, trend: 92, salary_growth: 0.14, entry: 600000,  y10: 2520000, automation_risk: 15 },
  'Data Scientist':             { demand: 93, trend: 90, salary_growth: 0.15, entry: 650000,  y10: 2600000, automation_risk: 12 },
  'Cybersecurity Specialist':   { demand: 91, trend: 88, salary_growth: 0.14, entry: 620000,  y10: 2356000, automation_risk: 10 },
  'Systems Architect':          { demand: 88, trend: 84, salary_growth: 0.13, entry: 800000,  y10: 2800000, automation_risk: 18 },
  'Doctor (MBBS / MD)':         { demand: 90, trend: 86, salary_growth: 0.10, entry: 800000,  y10: 4000000, automation_risk: 5  },
  'Investment Banker':          { demand: 85, trend: 81, salary_growth: 0.15, entry: 900000,  y10: 4950000, automation_risk: 30 },
  'Chartered Accountant':       { demand: 88, trend: 78, salary_growth: 0.12, entry: 700000,  y10: 2176000, automation_risk: 38 },
  'UX Designer':                { demand: 85, trend: 80, salary_growth: 0.13, entry: 550000,  y10: 2090000, automation_risk: 20 },
  'Lawyer':                     { demand: 80, trend: 76, salary_growth: 0.11, entry: 550000,  y10: 2475000, automation_risk: 22 },
  'Marketing Manager':          { demand: 82, trend: 75, salary_growth: 0.11, entry: 550000,  y10: 1890000, automation_risk: 28 },
  'Entrepreneur':               { demand: 80, trend: 78, salary_growth: 0.20, entry: 400000,  y10: 6192000, automation_risk: 10 },
  'Biomedical Researcher':      { demand: 75, trend: 70, salary_growth: 0.09, entry: 500000,  y10: 1185000, automation_risk: 12 },
  'Civil Services (IAS/IPS)':   { demand: 85, trend: 72, salary_growth: 0.08, entry: 600000,  y10: 1295000, automation_risk: 5  }
};

const EDUCATION_ROI_DATA = [
  { path: 'BCA → MCA',                    duration: 5, cost: 500000,  avg_salary: 650000,  roi_score: 92, roi_level: 'Very High', streams: ['engineering'] },
  { path: 'BTech Computer Science',        duration: 4, cost: 800000,  avg_salary: 750000,  roi_score: 88, roi_level: 'Very High', streams: ['engineering'] },
  { path: 'BTech Computer Science + MBA',  duration: 6, cost: 1800000, avg_salary: 1400000, roi_score: 82, roi_level: 'High',      streams: ['engineering', 'commerce'] },
  { path: 'BSc Data Science',              duration: 3, cost: 350000,  avg_salary: 600000,  roi_score: 86, roi_level: 'Very High', streams: ['engineering'] },
  { path: 'Diploma in AI/ML',              duration: 1, cost: 150000,  avg_salary: 500000,  roi_score: 84, roi_level: 'High',      streams: ['engineering'] },
  { path: 'CA (Chartered Accountancy)',    duration: 5, cost: 200000,  avg_salary: 700000,  roi_score: 80, roi_level: 'High',      streams: ['commerce'] },
  { path: 'MBA (IIM / Top-10)',            duration: 2, cost: 2500000, avg_salary: 1800000, roi_score: 75, roi_level: 'High',      streams: ['commerce'] },
  { path: 'BBA → MBA',                    duration: 5, cost: 900000,  avg_salary: 900000,  roi_score: 72, roi_level: 'Moderate',  streams: ['commerce'] },
  { path: 'MBBS',                          duration: 5, cost: 3000000, avg_salary: 800000,  roi_score: 68, roi_level: 'Moderate',  streams: ['medical'] },
  { path: 'MBBS + MD Specialisation',      duration: 9, cost: 5000000, avg_salary: 1500000, roi_score: 70, roi_level: 'Moderate',  streams: ['medical'] },
  { path: 'BA → LLB (Law)',               duration: 5, cost: 400000,  avg_salary: 550000,  roi_score: 65, roi_level: 'Moderate',  streams: ['humanities'] },
  { path: 'BA English / Mass Comm',        duration: 3, cost: 250000,  avg_salary: 350000,  roi_score: 55, roi_level: 'Moderate',  streams: ['humanities'] },
  { path: 'BSc Biomedical',               duration: 3, cost: 300000,  avg_salary: 400000,  roi_score: 62, roi_level: 'Moderate',  streams: ['medical'] },
  { path: 'IAS / Civil Services Prep',    duration: 4, cost: 300000,  avg_salary: 600000,  roi_score: 60, roi_level: 'Moderate',  streams: ['humanities'] },
  { path: 'UPSC + Masters in Public Policy', duration: 6, cost: 600000, avg_salary: 700000, roi_score: 58, roi_level: 'Moderate', streams: ['humanities'] }
];

const SKILL_DATA = [
  { skill: 'Python',              demand: 98, growth: 0.22, industries: ['Technology', 'Finance', 'Healthcare'] },
  { skill: 'Machine Learning',    demand: 96, growth: 0.25, industries: ['Technology', 'Finance'] },
  { skill: 'AWS / Cloud',         demand: 94, growth: 0.20, industries: ['Technology'] },
  { skill: 'SQL',                 demand: 92, growth: 0.15, industries: ['Technology', 'Finance', 'Consulting'] },
  { skill: 'Data Engineering',    demand: 91, growth: 0.23, industries: ['Technology', 'Finance'] },
  { skill: 'React / JavaScript',  demand: 90, growth: 0.18, industries: ['Technology'] },
  { skill: 'System Design',       demand: 88, growth: 0.17, industries: ['Technology'] },
  { skill: 'Docker / Kubernetes', demand: 87, growth: 0.21, industries: ['Technology'] },
  { skill: 'TensorFlow / PyTorch',demand: 85, growth: 0.24, industries: ['Technology', 'Research'] },
  { skill: 'NLP',                 demand: 83, growth: 0.28, industries: ['Technology'] },
  { skill: 'Cybersecurity',       demand: 82, growth: 0.19, industries: ['Technology', 'Finance', 'Government'] },
  { skill: 'Financial Modeling',  demand: 78, growth: 0.12, industries: ['Finance'] },
  { skill: 'Figma / UX',          demand: 76, growth: 0.17, industries: ['Technology', 'Marketing'] },
  { skill: 'Communication',       demand: 74, growth: 0.10, industries: ['All'] },
  { skill: 'Digital Marketing',   demand: 72, growth: 0.15, industries: ['Marketing', 'Technology'] }
];

const INDUSTRY_DATA = [
  { industry: 'Artificial Intelligence', growth_signal: 98, growth_label: 'Rapid Growth',  yoy: 0.28,  jobs_added: 185000,  description: 'Generative AI, LLMs, and AI infrastructure driving unprecedented hiring' },
  { industry: 'Cybersecurity',           growth_signal: 93, growth_label: 'High Growth',   yoy: 0.22,  jobs_added: 120000,  description: 'Rising threat landscape creating sustained high-skill demand globally' },
  { industry: 'Cloud Computing',         growth_signal: 91, growth_label: 'High Growth',   yoy: 0.20,  jobs_added: 145000,  description: 'Multi-cloud adoption accelerating across all enterprise sectors' },
  { industry: 'Data Engineering',        growth_signal: 89, growth_label: 'High Growth',   yoy: 0.19,  jobs_added: 98000,   description: 'Real-time analytics and data lakehouse architectures driving demand' },
  { industry: 'Fintech',                 growth_signal: 85, growth_label: 'Strong Growth', yoy: 0.16,  jobs_added: 76000,   description: 'Digital payments, embedded finance, and crypto infrastructure expanding' },
  { industry: 'Healthcare Technology',   growth_signal: 82, growth_label: 'Strong Growth', yoy: 0.15,  jobs_added: 68000,   description: 'MedTech, telemedicine, and AI-assisted diagnostics scaling rapidly' },
  { industry: 'Green Energy / CleanTech',growth_signal: 79, growth_label: 'Emerging',      yoy: 0.24,  jobs_added: 55000,   description: 'Solar, wind, and EV infrastructure generating new engineering roles' },
  { industry: 'EdTech',                  growth_signal: 72, growth_label: 'Growing',       yoy: 0.13,  jobs_added: 42000,   description: 'Online learning platforms and AI tutoring tools expanding globally' },
  { industry: 'Semiconductor / Chips',   growth_signal: 76, growth_label: 'Emerging',      yoy: 0.18,  jobs_added: 38000,   description: 'VLSI, chip design, and fab engineering surging post supply-chain crisis' },
  { industry: 'Legal Technology',        growth_signal: 61, growth_label: 'Growing',       yoy: 0.11,  jobs_added: 22000,   description: 'Contract automation and legal AI tools disrupting traditional law firms' },
  { industry: 'Traditional Finance',     growth_signal: 55, growth_label: 'Stable',        yoy: 0.07,  jobs_added: 18000,   description: 'Steady demand; automation reshaping back-office roles' },
  { industry: 'Traditional Media',       growth_signal: 38, growth_label: 'Declining',     yoy: -0.04, jobs_added: -8000,   description: 'Print and broadcast contracting; digital pivots partially offsetting losses' }
];

// ─── Helper ───────────────────────────────────────────────────────────────────

function _projectSalary(entry, growthRate, years) {
  return Math.round(entry * Math.pow(1 + growthRate, years));
}

// ─── 1. Career Demand Index ───────────────────────────────────────────────────

async function getCareerDemand() {
  const cached = _memGet(METRIC_NAMES.CAREER_DEMAND);
  if (cached) return cached;

  // Try to enrich with live LMI data
  let liveScores = {};
  try {
    liveScores = await marketTrend.getCareerScoresMap();
  } catch (_) {}

  const careers = Object.entries(CAREER_BENCHMARKS).map(([name, b]) => {
    const live = liveScores[name] ?? {};
    const demand       = live.demand_score    ?? b.demand;
    const trend        = live.trend_score     ?? b.trend;
    const salaryGrowth = live.salary_growth   ?? b.salary_growth;
    const autoRisk     = live.automation_risk ?? b.automation_risk;

    // Composite demand index: 50% demand + 30% trend + 20% (1 - automation_risk/100)
    const index = Math.round(demand * 0.50 + trend * 0.30 + (100 - autoRisk) * 0.20);
    return {
      career: name,
      demand_index:   Math.min(100, index),
      demand_score:   demand,
      trend_score:    trend,
      salary_growth:  salaryGrowth,
      automation_risk: autoRisk,
      entry_salary:   live.avg_entry_salary ?? b.entry,
      salary_10yr:    live.avg_10yr_salary  ?? b.y10
    };
  });
  careers.sort((a, b) => b.demand_index - a.demand_index);

  const result = { careers, generated_at: new Date().toISOString() };
  _memSet(METRIC_NAMES.CAREER_DEMAND, result);
  await _persistSnapshot(METRIC_NAMES.CAREER_DEMAND, result);
  return result;
}

// ─── 2. Skill Demand Index ────────────────────────────────────────────────────

async function getSkillDemand() {
  const cached = _memGet(METRIC_NAMES.SKILL_DEMAND);
  if (cached) return cached;

  let liveSkills = [];
  try {
    liveSkills = await marketTrend.getSkillDemand(30);
  } catch (_) {}

  // Merge live LMI with static enrichment
  const liveMap = {};
  for (const s of liveSkills) liveMap[s.skill_name] = s;

  const skills = SKILL_DATA.map(s => {
    const live       = liveMap[s.skill] ?? {};
    const demand     = live.demand_score  ?? s.demand;
    const growth     = live.growth_rate   ?? s.growth;
    const industries = live.industry_usage?.length ? live.industry_usage : s.industries;

    // Composite: 70% demand + 30% growth velocity (normalised to 0-100)
    const growthNorm = Math.min(100, Math.round(growth * 300)); // 0.33+ → 100
    const index = Math.round(demand * 0.70 + growthNorm * 0.30);
    return {
      skill: s.skill,
      demand_index: Math.min(100, index),
      demand_score: demand,
      growth_rate:  growth,
      industries
    };
  });
  skills.sort((a, b) => b.demand_index - a.demand_index);

  const result = { skills, generated_at: new Date().toISOString() };
  _memSet(METRIC_NAMES.SKILL_DEMAND, result);
  await _persistSnapshot(METRIC_NAMES.SKILL_DEMAND, result);
  return result;
}

// ─── 3. Education ROI Index ───────────────────────────────────────────────────

async function getEducationROI() {
  const cached = _memGet(METRIC_NAMES.EDUCATION_ROI);
  if (cached) return cached;

  // Optionally enrich with aggregated student ROI data from Supabase
  let studentROIAvg = {};
  try {
    const { data: roiRows } = await supabase
      .from('edu_education_roi')
      .select('education_path, roi_score');

    if (roiRows && roiRows.length > 0) {
      const grouped = {};
      roiRows.forEach(d => {
        if (!d.education_path || !d.roi_score) return;
        if (!grouped[d.education_path]) grouped[d.education_path] = [];
        grouped[d.education_path].push(d.roi_score);
      });
      for (const [path, scores] of Object.entries(grouped)) {
        studentROIAvg[path] = Math.round(
          scores.reduce((a, b) => a + b, 0) / scores.length
        );
      }
    }
  } catch (_) {}

  const paths = EDUCATION_ROI_DATA.map(p => {
    // If we have real student data for this path, blend 60/40 with static
    const liveScore = studentROIAvg[p.path];
    const roi_score = liveScore
      ? Math.round(p.roi_score * 0.40 + liveScore * 0.60)
      : p.roi_score;
    const roi_level =
      roi_score >= 85 ? 'Very High' :
      roi_score >= 70 ? 'High' :
      roi_score >= 55 ? 'Moderate' : 'Low';

    // Simple payback: cost / (avg_salary - 200000 living)
    const net_annual  = Math.max(1, p.avg_salary - 200000);
    const payback_years = parseFloat((p.cost / net_annual).toFixed(1));
    return {
      path:           p.path,
      duration_years: p.duration,
      estimated_cost: p.cost,
      avg_salary:     p.avg_salary,
      roi_score,
      roi_level,
      payback_years,
      streams:        p.streams
    };
  });
  paths.sort((a, b) => b.roi_score - a.roi_score);

  const result = { paths, generated_at: new Date().toISOString() };
  _memSet(METRIC_NAMES.EDUCATION_ROI, result);
  await _persistSnapshot(METRIC_NAMES.EDUCATION_ROI, result);
  return result;
}

// ─── 4. Career Growth Forecast ────────────────────────────────────────────────

async function getCareerGrowth() {
  const cached = _memGet(METRIC_NAMES.CAREER_GROWTH);
  if (cached) return cached;

  let liveScores = {};
  try {
    liveScores = await marketTrend.getCareerScoresMap();
  } catch (_) {}

  const forecasts = Object.entries(CAREER_BENCHMARKS).map(([name, b]) => {
    const live       = liveScores[name] ?? {};
    const entry      = live.avg_entry_salary ?? b.entry;
    const growthRate = live.salary_growth    ?? b.salary_growth;
    const demand     = live.demand_score     ?? b.demand;
    const milestones = [1, 3, 5, 7, 10].map(yr => ({
      year:   yr,
      salary: _projectSalary(entry, growthRate, yr - 1)
    }));
    return {
      career:       name,
      entry_salary: entry,
      salary_3yr:   _projectSalary(entry, growthRate, 2),
      salary_5yr:   _projectSalary(entry, growthRate, 4),
      salary_10yr:  _projectSalary(entry, growthRate, 9),
      annual_growth: growthRate,
      demand_score: demand,
      milestones
    };
  });

  // Sort by 10-year salary descending
  forecasts.sort((a, b) => b.salary_10yr - a.salary_10yr);

  const result = { forecasts, generated_at: new Date().toISOString() };
  _memSet(METRIC_NAMES.CAREER_GROWTH, result);
  await _persistSnapshot(METRIC_NAMES.CAREER_GROWTH, result);
  return result;
}

// ─── 5. Industry Trend Analysis ───────────────────────────────────────────────

async function getIndustryTrends() {
  const cached = _memGet(METRIC_NAMES.INDUSTRY_TRENDS);
  if (cached) return cached;

  const industries = [...INDUSTRY_DATA].sort((a, b) => b.growth_signal - a.growth_signal);
  const result = { industries, generated_at: new Date().toISOString() };
  _memSet(METRIC_NAMES.INDUSTRY_TRENDS, result);
  await _persistSnapshot(METRIC_NAMES.INDUSTRY_TRENDS, result);
  return result;
}

// ─── Snapshot persistence (non-blocking) ─────────────────────────────────────

async function _persistSnapshot(metricName, data) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const now   = new Date().toISOString();

    // Upsert cache doc
    await supabase
      .from(COLLECTIONS.AGGREGATED_CACHE)
      .upsert(
        {
          id: metricName,
          ...buildCacheDoc(metricName, data),
          computed_at: now
        },
        { onConflict: 'id' }
      );

    // Write snapshot doc for historical trend lines (insert only if not exists for today)
    const snapshotId = `${metricName}_${today}`;
    const { data: existing } = await supabase
      .from(COLLECTIONS.SNAPSHOTS)
      .select('id')
      .eq('id', snapshotId)
      .maybeSingle();

    if (!existing) {
      await supabase
        .from(COLLECTIONS.SNAPSHOTS)
        .insert({
          id: snapshotId,
          ...buildSnapshotDoc({
            metric_name:   metricName,
            metric_value:  data,
            region:        'india',
            snapshot_date: today
          }),
          created_at: now
        });
    }
  } catch (err) {
    logger.warn({ err: err.message }, '[GCID] Snapshot persist failed (non-blocking)');
  }
}

// ─── Historical snapshots (for trend lines) ───────────────────────────────────

async function getSnapshots(metricName, limitDays = 30) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - limitDays);

  const { data, error } = await supabase
    .from(COLLECTIONS.SNAPSHOTS)
    .select('*')
    .eq('metric_name', metricName)
    .gte('created_at', cutoff.toISOString())
    .order('created_at', { ascending: true })
    .limit(limitDays);

  if (error) throw error;
  return data || [];
}

module.exports = {
  getCareerDemand,
  getSkillDemand,
  getEducationROI,
  getCareerGrowth,
  getIndustryTrends,
  getSnapshots
};