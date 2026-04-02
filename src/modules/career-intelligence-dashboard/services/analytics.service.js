'use strict';

/**
 * src/modules/analytics/services/analytics.service.js
 *
 * Supabase-native analytics aggregation service.
 */

const logger = require('../../../utils/logger');
const { supabase } = require('../../../config/supabase');
const marketTrend = require('../../labor-market-intelligence/services/marketTrend.service');

const {
  TABLES,
  METRIC_NAMES,
  buildSnapshotRow,
  buildCacheRow,
} = require('../models/analyticsSnapshot.model');

const MEM_TTL_MS = 10 * 60 * 1000;
const memCache = new Map();

function memGet(key) {
  const cached = memCache.get(key);
  if (!cached) return null;

  if (Date.now() - cached.ts > MEM_TTL_MS) {
    memCache.delete(key);
    return null;
  }

  return cached.value;
}

function memSet(key, value) {
  memCache.set(key, {
    value,
    ts: Date.now(),
  });
}

function projectSalary(entry, growthRate, years) {
  return Math.round(entry * Math.pow(1 + growthRate, years));
}

/* -------------------------------------------------------------------------- */
/* Static datasets preserved exactly */
/* -------------------------------------------------------------------------- */

const CAREER_BENCHMARKS = { /* KEEP YOUR EXISTING DATASET EXACTLY AS-IS */ };
const EDUCATION_ROI_DATA = [ /* KEEP EXACTLY AS-IS */ ];
const SKILL_DATA = [ /* KEEP EXACTLY AS-IS */ ];
const INDUSTRY_DATA = [ /* KEEP EXACTLY AS-IS */ ];

/* -------------------------------------------------------------------------- */
/* Shared metric compute wrapper */
/* -------------------------------------------------------------------------- */

async function resolveMetric(metricName, computeFn) {
  const cached = memGet(metricName);
  if (cached) return cached;

  const result = await computeFn();

  memSet(metricName, result);

  void persistSnapshot(metricName, result);

  return result;
}

/* -------------------------------------------------------------------------- */
/* 1 Career Demand */
/* -------------------------------------------------------------------------- */

async function getCareerDemand() {
  return resolveMetric(METRIC_NAMES.CAREER_DEMAND, async () => {
    let liveScores = {};

    try {
      liveScores = await marketTrend.getCareerScoresMap();
    } catch (error) {
      logger.warn(
        { error: error.message },
        '[AnalyticsService] marketTrend career scores fallback'
      );
    }

    const careers = Object.entries(CAREER_BENCHMARKS)
      .map(([name, benchmark]) => {
        const live = liveScores[name] ?? {};

        const demand = live.demand_score ?? benchmark.demand;
        const trend = live.trend_score ?? benchmark.trend;
        const salaryGrowth = live.salary_growth ?? benchmark.salary_growth;
        const autoRisk = live.automation_risk ?? benchmark.automation_risk;

        const demandIndex = Math.round(
          demand * 0.5 + trend * 0.3 + (100 - autoRisk) * 0.2
        );

        return {
          career: name,
          demand_index: Math.min(100, demandIndex),
          demand_score: demand,
          trend_score: trend,
          salary_growth: salaryGrowth,
          automation_risk: autoRisk,
          entry_salary: live.avg_entry_salary ?? benchmark.entry,
          salary_10yr: live.avg_10yr_salary ?? benchmark.y10,
        };
      })
      .sort((a, b) => b.demand_index - a.demand_index);

    return {
      careers,
      generated_at: new Date().toISOString(),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* 2 Skill Demand */
/* -------------------------------------------------------------------------- */

async function getSkillDemand() {
  return resolveMetric(METRIC_NAMES.SKILL_DEMAND, async () => {
    let liveSkills = [];

    try {
      liveSkills = await marketTrend.getSkillDemand(30);
    } catch (error) {
      logger.warn(
        { error: error.message },
        '[AnalyticsService] marketTrend skill fallback'
      );
    }

    const liveMap = new Map(
      liveSkills.map((skill) => [skill.skill_name, skill])
    );

    const skills = SKILL_DATA.map((skill) => {
      const live = liveMap.get(skill.skill) ?? {};

      const demand = live.demand_score ?? skill.demand;
      const growth = live.growth_rate ?? skill.growth;
      const industries =
        live.industry_usage?.length > 0
          ? live.industry_usage
          : skill.industries;

      const growthNorm = Math.min(100, Math.round(growth * 300));
      const demandIndex = Math.round(demand * 0.7 + growthNorm * 0.3);

      return {
        skill: skill.skill,
        demand_index: Math.min(100, demandIndex),
        demand_score: demand,
        growth_rate: growth,
        industries,
      };
    }).sort((a, b) => b.demand_index - a.demand_index);

    return {
      skills,
      generated_at: new Date().toISOString(),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* 3 Education ROI */
/* -------------------------------------------------------------------------- */

async function getEducationROI() {
  return resolveMetric(METRIC_NAMES.EDUCATION_ROI, async () => {
    const studentROIAvg = {};

    try {
      const { data: roiRows, error } = await supabase
        .from('edu_education_roi')
        .select('education_path, roi_score');

      if (error) throw error;

      const grouped = new Map();

      for (const row of roiRows ?? []) {
        if (!row.education_path || row.roi_score == null) continue;

        const arr = grouped.get(row.education_path) ?? [];
        arr.push(row.roi_score);
        grouped.set(row.education_path, arr);
      }

      for (const [path, scores] of grouped.entries()) {
        studentROIAvg[path] = Math.round(
          scores.reduce((sum, val) => sum + val, 0) / scores.length
        );
      }
    } catch (error) {
      logger.warn(
        { error: error.message },
        '[AnalyticsService] education ROI enrichment fallback'
      );
    }

    const paths = EDUCATION_ROI_DATA.map((path) => {
      const liveScore = studentROIAvg[path.path];

      const roiScore =
        liveScore != null
          ? Math.round(path.roi_score * 0.4 + liveScore * 0.6)
          : path.roi_score;

      const roiLevel =
        roiScore >= 85
          ? 'Very High'
          : roiScore >= 70
            ? 'High'
            : roiScore >= 55
              ? 'Moderate'
              : 'Low';

      const netAnnual = Math.max(1, path.avg_salary - 200000);

      return {
        path: path.path,
        duration_years: path.duration,
        estimated_cost: path.cost,
        avg_salary: path.avg_salary,
        roi_score: roiScore,
        roi_level: roiLevel,
        payback_years: Number((path.cost / netAnnual).toFixed(1)),
        streams: path.streams,
      };
    }).sort((a, b) => b.roi_score - a.roi_score);

    return {
      paths,
      generated_at: new Date().toISOString(),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* 4 Career Growth */
/* -------------------------------------------------------------------------- */

async function getCareerGrowth() {
  return resolveMetric(METRIC_NAMES.CAREER_GROWTH, async () => {
    let liveScores = {};

    try {
      liveScores = await marketTrend.getCareerScoresMap();
    } catch (_) {}

    const forecasts = Object.entries(CAREER_BENCHMARKS)
      .map(([name, benchmark]) => {
        const live = liveScores[name] ?? {};
        const entry = live.avg_entry_salary ?? benchmark.entry;
        const growthRate =
          live.salary_growth ?? benchmark.salary_growth;

        return {
          career: name,
          entry_salary: entry,
          salary_3yr: projectSalary(entry, growthRate, 2),
          salary_5yr: projectSalary(entry, growthRate, 4),
          salary_10yr: projectSalary(entry, growthRate, 9),
          annual_growth: growthRate,
          demand_score: live.demand_score ?? benchmark.demand,
          milestones: [1, 3, 5, 7, 10].map((year) => ({
            year,
            salary: projectSalary(entry, growthRate, year - 1),
          })),
        };
      })
      .sort((a, b) => b.salary_10yr - a.salary_10yr);

    return {
      forecasts,
      generated_at: new Date().toISOString(),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* 5 Industry Trends */
/* -------------------------------------------------------------------------- */

async function getIndustryTrends() {
  return resolveMetric(METRIC_NAMES.INDUSTRY_TRENDS, async () => ({
    industries: [...INDUSTRY_DATA].sort(
      (a, b) => b.growth_signal - a.growth_signal
    ),
    generated_at: new Date().toISOString(),
  }));
}

/* -------------------------------------------------------------------------- */
/* Snapshot persistence */
/* -------------------------------------------------------------------------- */

async function persistSnapshot(metricName, data) {
  try {
    const cacheRow = buildCacheRow(metricName, data);
    const snapshotRow = buildSnapshotRow({
      metric_name: metricName,
      metric_value: data,
    });

    await Promise.all([
      supabase
        .from(TABLES.AGGREGATED_CACHE)
        .upsert(cacheRow, {
          onConflict: 'metric_name',
        }),

      supabase
        .from(TABLES.SNAPSHOTS)
        .upsert(snapshotRow, {
          onConflict: 'metric_name,region,snapshot_date',
        }),
    ]);
  } catch (error) {
    logger.warn(
      { metricName, error: error.message },
      '[AnalyticsService] snapshot persist failed'
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Historical snapshots */
/* -------------------------------------------------------------------------- */

async function getSnapshots(metricName, limitDays = 30) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - limitDays);

  const { data, error } = await supabase
    .from(TABLES.SNAPSHOTS)
    .select('metric_name, metric_value, region, snapshot_date, created_at')
    .eq('metric_name', metricName)
    .gte('snapshot_date', cutoff.toISOString().slice(0, 10))
    .order('snapshot_date', { ascending: true })
    .limit(limitDays);

  if (error) throw error;

  return data ?? [];
}

module.exports = Object.freeze({
  getCareerDemand,
  getSkillDemand,
  getEducationROI,
  getCareerGrowth,
  getIndustryTrends,
  getSnapshots,
});