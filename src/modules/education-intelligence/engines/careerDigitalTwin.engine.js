'use strict';

/**
 * engines/careerDigitalTwin.engine.js
 *
 * Career Digital Twin Engine (CDTE)
 * Deterministic, production-hardened salary simulation engine.
 */

const ENGINE_VERSION = '1.1.0';

const CAREER_BENCHMARKS = {
  'Software Engineer': {
    base_salary: 600000,
    annual_growth_rate: 0.14,
    demand_score: 0.95,
    demand_level: 'Very High',
    peak_multiplier: 4.2
  },
  'AI / ML Engineer': {
    base_salary: 750000,
    annual_growth_rate: 0.17,
    demand_score: 0.98,
    demand_level: 'Exceptional',
    peak_multiplier: 4.8
  },
  'Data Scientist': {
    base_salary: 650000,
    annual_growth_rate: 0.15,
    demand_score: 0.93,
    demand_level: 'Very High',
    peak_multiplier: 4.0
  },
  'Cybersecurity Specialist': {
    base_salary: 620000,
    annual_growth_rate: 0.14,
    demand_score: 0.91,
    demand_level: 'Very High',
    peak_multiplier: 3.8
  },
  'Systems Architect': {
    base_salary: 800000,
    annual_growth_rate: 0.13,
    demand_score: 0.88,
    demand_level: 'High',
    peak_multiplier: 3.5
  },
  'Doctor (MBBS / MD)': {
    base_salary: 800000,
    annual_growth_rate: 0.10,
    demand_score: 0.90,
    demand_level: 'Very High',
    peak_multiplier: 5.0
  },
  'Biomedical Researcher': {
    base_salary: 500000,
    annual_growth_rate: 0.09,
    demand_score: 0.75,
    demand_level: 'High',
    peak_multiplier: 3.2
  },
  'Pharmacist': {
    base_salary: 450000,
    annual_growth_rate: 0.08,
    demand_score: 0.72,
    demand_level: 'Moderate',
    peak_multiplier: 2.8
  },
  'Chartered Accountant': {
    base_salary: 700000,
    annual_growth_rate: 0.12,
    demand_score: 0.88,
    demand_level: 'High',
    peak_multiplier: 4.0
  },
  'Investment Banker': {
    base_salary: 900000,
    annual_growth_rate: 0.15,
    demand_score: 0.85,
    demand_level: 'High',
    peak_multiplier: 5.5
  },
  Entrepreneur: {
    base_salary: 400000,
    annual_growth_rate: 0.20,
    demand_score: 0.80,
    demand_level: 'High',
    peak_multiplier: 10.0
  },
  'Marketing Manager': {
    base_salary: 550000,
    annual_growth_rate: 0.11,
    demand_score: 0.82,
    demand_level: 'High',
    peak_multiplier: 3.5
  },
  Lawyer: {
    base_salary: 550000,
    annual_growth_rate: 0.11,
    demand_score: 0.80,
    demand_level: 'High',
    peak_multiplier: 4.5
  },
  'Journalist / Writer': {
    base_salary: 350000,
    annual_growth_rate: 0.07,
    demand_score: 0.60,
    demand_level: 'Moderate',
    peak_multiplier: 2.5
  },
  'UX Designer': {
    base_salary: 550000,
    annual_growth_rate: 0.13,
    demand_score: 0.85,
    demand_level: 'High',
    peak_multiplier: 3.8
  },
  'Civil Services (IAS/IPS)': {
    base_salary: 600000,
    annual_growth_rate: 0.08,
    demand_score: 0.85,
    demand_level: 'Stable',
    peak_multiplier: 3.0
  }
};

const DEFAULT_BENCHMARK = {
  base_salary: 500000,
  annual_growth_rate: 0.10,
  demand_score: 0.70,
  demand_level: 'Moderate',
  peak_multiplier: 3.0
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundSalary(value) {
  return Math.round(value / 5000) * 5000;
}

function normalizeCareerKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function normalizeGrowthRate(value, fallback) {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) return fallback;

  // convert percentage-style values like 12 → 0.12
  if (numeric > 1) return numeric / 100;

  return numeric;
}

function cognitiveBoost(cognitiveResult) {
  const scores = Object.values(
    cognitiveResult?.scores || {}
  )
    .map(Number)
    .filter(Number.isFinite);

  if (!scores.length) return 1;

  const average =
    scores.reduce((sum, score) => sum + score, 0) /
    scores.length;

  return 0.9 + (average / 100) * 0.25;
}

function learningVelocityFactor(academicResult) {
  const velocity =
    academicResult?.overall_learning_velocity ?? 0;

  const normalized = clamp(velocity, -5, 5);

  return 1 + (normalized / 5) * 0.1;
}

async function simulate(
  careerResult,
  roiResult,
  cognitiveResult,
  academicResult,
  marketScores = {}
) {
  const topCareers = careerResult?.top_careers || [];

  if (!topCareers.length) {
    return {
      simulations: [],
      engine_version: ENGINE_VERSION
    };
  }

  const cogBoost = cognitiveBoost(cognitiveResult);
  const velFactor = learningVelocityFactor(
    academicResult
  );
  const roiByCareer = buildROIIndex(roiResult);

  const simulations = topCareers
    .map(({ career, probability }) => {
      const benchmark =
        CAREER_BENCHMARKS[career] ||
        DEFAULT_BENCHMARK;

      const lmiScore = marketScores?.[career] || null;

      const probabilityFactor = clamp(
        Number(probability) / 100,
        0.3,
        1
      );

      const liveDemand = Number.isFinite(
        lmiScore?.demand_score
      )
        ? lmiScore.demand_score / 100
        : null;

      const demandSignal =
        liveDemand !== null
          ? benchmark.demand_score * 0.4 +
            liveDemand * 0.6
          : benchmark.demand_score;

      const baseGrowth = normalizeGrowthRate(
        lmiScore?.salary_growth,
        benchmark.annual_growth_rate
      );

      const effectiveGrowth = clamp(
        baseGrowth *
          (0.6 + probabilityFactor * 0.4) *
          (0.8 + demandSignal * 0.2) *
          cogBoost *
          velFactor,
        0.04,
        0.25
      );

      const baseSalary = roundSalary(
        benchmark.base_salary *
          (0.85 + probabilityFactor * 0.15)
      );

      const salaryCap =
        benchmark.base_salary *
        benchmark.peak_multiplier;

      const milestones = [];

      for (let year = 1; year <= 10; year++) {
        const projected =
          baseSalary *
          (1 + effectiveGrowth) ** (year - 1);

        milestones.push({
          year,
          salary: roundSalary(
            Math.min(projected, salaryCap)
          )
        });
      }

      const roiMatch =
        roiByCareer[normalizeCareerKey(career)] ||
        null;

      return {
        career,
        probability,
        entry_salary: milestones[0].salary,
        salary_3_year: milestones[2].salary,
        salary_5_year: milestones[4].salary,
        salary_10_year: milestones[9].salary,
        annual_growth_rate:
          Math.round(effectiveGrowth * 1000) / 1000,
        demand_level: benchmark.demand_level,
        roi_level: roiMatch?.roi_level || 'Moderate',
        best_education_path: roiMatch?.path || null,
        milestones
      };
    })
    .sort((a, b) => b.salary_10_year - a.salary_10_year);

  return {
    simulations,
    engine_version: ENGINE_VERSION
  };
}

function buildROIIndex(roiResult) {
  const index = {};
  const options = roiResult?.education_options || [];

  for (const option of options) {
    for (const career of option.matched_careers || []) {
      const key = normalizeCareerKey(career);

      if (
        !index[key] ||
        option.roi_score > index[key].roi_score
      ) {
        index[key] = {
          path: option.path,
          roi_level: option.roi_level,
          roi_score: option.roi_score
        };
      }
    }
  }

  return index;
}

module.exports = {
  simulate,
  CAREER_BENCHMARKS
};