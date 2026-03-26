'use strict';

/**
 * engines/careerDigitalTwin.engine.js
 *
 * Career Digital Twin Engine (CDTE)
 *
 * Simulates a student's future career trajectory based on all prior
 * engine outputs. For each top career, it produces a salary projection
 * from Year 1 through Year 10, adjusted by:
 *   - career_probability   (from CareerSuccessEngine)
 *   - demand_score         (from CAREER_BENCHMARKS dataset)
 *   - cognitive_boost      (derived from CognitiveProfileEngine)
 *   - learning_velocity    (from AcademicTrendEngine)
 *   - roi_level            (from EducationROIEngine, where available)
 *
 * Projection model:
 *   base_salary       = CAREER_BENCHMARKS[career].base_salary
 *   growth_rate       = CAREER_BENCHMARKS[career].annual_growth_rate
 *                         × probability_factor
 *                         × demand_factor
 *                         × cognitive_factor
 *   year_n_salary     = base_salary × (1 + growth_rate)^(n-1)
 *   milestones:       year 1, year 3, year 5, year 10
 *
 * Output:
 * {
 *   simulations: [
 *     {
 *       career:           'Software Engineer',
 *       probability:       82,
 *       entry_salary:      600000,
 *       salary_3_year:     900000,
 *       salary_5_year:     1200000,
 *       salary_10_year:    2500000,
 *       annual_growth_rate: 0.148,
 *       demand_level:      'Very High',
 *       roi_level:         'High',
 *       best_education_path: 'BTech Computer Science',
 *       milestones: [
 *         { year: 1, salary: 600000 },
 *         { year: 2, salary: 690000 },
 *         ...
 *         { year: 10, salary: 2500000 },
 *       ],
 *     },
 *   ],
 *   engine_version: '1.0.0',
 * }
 */

const ENGINE_VERSION = '1.0.0';

// ─── Career Benchmark Dataset ─────────────────────────────────────────────────
//
// base_salary       — starting annual salary in INR (realistic market avg)
// annual_growth_rate — base YoY salary growth rate (0–1)
// demand_score      — labour market demand signal (0–1, higher = more demand)
// demand_level      — human-readable demand label
// peak_multiplier   — realistic 10-year ceiling relative to base salary

const CAREER_BENCHMARKS = {
  // ── Engineering / Technology ───────────────────────────────────────────
  'Software Engineer': {
    base_salary:        600000,
    annual_growth_rate: 0.14,
    demand_score:       0.95,
    demand_level:       'Very High',
    peak_multiplier:    4.2,
  },
  'AI / ML Engineer': {
    base_salary:        750000,
    annual_growth_rate: 0.17,
    demand_score:       0.98,
    demand_level:       'Exceptional',
    peak_multiplier:    4.8,
  },
  'Data Scientist': {
    base_salary:        650000,
    annual_growth_rate: 0.15,
    demand_score:       0.93,
    demand_level:       'Very High',
    peak_multiplier:    4.0,
  },
  'Cybersecurity Specialist': {
    base_salary:        620000,
    annual_growth_rate: 0.14,
    demand_score:       0.91,
    demand_level:       'Very High',
    peak_multiplier:    3.8,
  },
  'Systems Architect': {
    base_salary:        800000,
    annual_growth_rate: 0.13,
    demand_score:       0.88,
    demand_level:       'High',
    peak_multiplier:    3.5,
  },

  // ── Medical / Science ──────────────────────────────────────────────────
  'Doctor (MBBS / MD)': {
    base_salary:        800000,
    annual_growth_rate: 0.10,
    demand_score:       0.90,
    demand_level:       'Very High',
    peak_multiplier:    5.0,
  },
  'Biomedical Researcher': {
    base_salary:        500000,
    annual_growth_rate: 0.09,
    demand_score:       0.75,
    demand_level:       'High',
    peak_multiplier:    3.2,
  },
  'Pharmacist': {
    base_salary:        450000,
    annual_growth_rate: 0.08,
    demand_score:       0.72,
    demand_level:       'Moderate',
    peak_multiplier:    2.8,
  },

  // ── Commerce / Business ────────────────────────────────────────────────
  'Chartered Accountant': {
    base_salary:        700000,
    annual_growth_rate: 0.12,
    demand_score:       0.88,
    demand_level:       'High',
    peak_multiplier:    4.0,
  },
  'Investment Banker': {
    base_salary:        900000,
    annual_growth_rate: 0.15,
    demand_score:       0.85,
    demand_level:       'High',
    peak_multiplier:    5.5,
  },
  'Entrepreneur': {
    base_salary:        400000,
    annual_growth_rate: 0.20,
    demand_score:       0.80,
    demand_level:       'High',
    peak_multiplier:    10.0,  // High variance — ceiling reflects upside
  },
  'Marketing Manager': {
    base_salary:        550000,
    annual_growth_rate: 0.11,
    demand_score:       0.82,
    demand_level:       'High',
    peak_multiplier:    3.5,
  },

  // ── Humanities / Law ───────────────────────────────────────────────────
  'Lawyer': {
    base_salary:        550000,
    annual_growth_rate: 0.11,
    demand_score:       0.80,
    demand_level:       'High',
    peak_multiplier:    4.5,
  },
  'Journalist / Writer': {
    base_salary:        350000,
    annual_growth_rate: 0.07,
    demand_score:       0.60,
    demand_level:       'Moderate',
    peak_multiplier:    2.5,
  },
  'UX Designer': {
    base_salary:        550000,
    annual_growth_rate: 0.13,
    demand_score:       0.85,
    demand_level:       'High',
    peak_multiplier:    3.8,
  },
  'Civil Services (IAS/IPS)': {
    base_salary:        600000,
    annual_growth_rate: 0.08,
    demand_score:       0.85,
    demand_level:       'Stable',
    peak_multiplier:    3.0,
  },
};

const DEFAULT_BENCHMARK = {
  base_salary:        500000,
  annual_growth_rate: 0.10,
  demand_score:       0.70,
  demand_level:       'Moderate',
  peak_multiplier:    3.0,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function _round(n) {
  // Round to nearest 5000 for realistic salary figures
  return Math.round(n / 5000) * 5000;
}

// Derive a cognitive boost factor (0.90 – 1.15) from cognitive scores
function _cognitiveBoost(cognitiveResult) {
  if (!cognitiveResult?.scores) return 1.0;

  const scores = cognitiveResult.scores;
  const avg = Object.values(scores).reduce((s, v) => s + Number(v || 0), 0)
              / Math.max(Object.values(scores).length, 1);

  // avg 0–100 → factor 0.90–1.15
  return 0.90 + (avg / 100) * 0.25;
}

// Derive a learning velocity factor (0.95 – 1.10) from academic result
function _learningVelocityFactor(academicResult) {
  const velocity = academicResult?.overall_learning_velocity ?? 0;
  // velocity typically -5 to +5 → map to 0.95–1.10
  const clamped = _clamp(velocity, -5, 5);
  return 1.0 + (clamped / 5) * 0.10;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * @param {object} careerResult   — CareerSuccessEngine output
 * @param {object} roiResult      — EducationROIEngine output
 * @param {object} cognitiveResult — CognitiveProfileEngine output
 * @param {object} academicResult  — AcademicTrendEngine output
 * @returns {DigitalTwinResult}
 */
async function simulate(careerResult, roiResult, cognitiveResult, academicResult, marketScores = {}) {
  if (!careerResult?.top_careers?.length) {
    return { simulations: [], engine_version: ENGINE_VERSION };
  }

  const cogBoost     = _cognitiveBoost(cognitiveResult);
  const velFactor    = _learningVelocityFactor(academicResult);
  const roiByCareer  = _buildROIIndex(roiResult);

  const simulations = careerResult.top_careers.map(({ career, probability }) => {
    const bench      = CAREER_BENCHMARKS[career] ?? DEFAULT_BENCHMARK;
    const lmiScore   = marketScores[career] ?? null;
    const probFact   = _clamp(probability / 100, 0.3, 1.0);

    // Blend static benchmark demand with live LMI signal (if available)
    const liveDemand = lmiScore ? lmiScore.demand_score / 100 : null;
    const demandSig  = liveDemand != null
      ? (bench.demand_score * 0.4 + liveDemand * 0.6)   // weight live data more
      : bench.demand_score;

    // Use live salary growth if available
    const baseGrowth = lmiScore?.salary_growth ?? bench.annual_growth_rate;

    // ── Effective annual growth rate ──────────────────────────────────
    const effectiveGrowth = _clamp(
      baseGrowth
        * (0.6 + probFact * 0.4)
        * (0.8 + demandSig * 0.2)
        * cogBoost
        * velFactor,
      0.04,
      0.25
    );

    // ── Salary projections ────────────────────────────────────────────
    const base = _round(bench.base_salary * (0.85 + probFact * 0.15));
    const cap  = bench.base_salary * bench.peak_multiplier;

    const milestones = [];
    for (let year = 1; year <= 10; year++) {
      const raw = base * Math.pow(1 + effectiveGrowth, year - 1);
      milestones.push({ year, salary: _round(Math.min(raw, cap)) });
    }

    const y1  = milestones[0].salary;
    const y3  = milestones[2].salary;
    const y5  = milestones[4].salary;
    const y10 = milestones[9].salary;

    // ── Best matching education path + ROI level ──────────────────────
    const roiMatch = roiByCareer[career.toLowerCase()] ?? null;

    return {
      career,
      probability,
      entry_salary:       y1,
      salary_3_year:      y3,
      salary_5_year:      y5,
      salary_10_year:     y10,
      annual_growth_rate: Math.round(effectiveGrowth * 1000) / 1000,
      demand_level:       bench.demand_level,
      roi_level:          roiMatch?.roi_level  ?? 'Moderate',
      best_education_path: roiMatch?.path      ?? null,
      milestones,
    };
  });

  // Sort by 10-year salary descending
  simulations.sort((a, b) => b.salary_10_year - a.salary_10_year);

  return { simulations, engine_version: ENGINE_VERSION };
}

// Build a quick career→ROI lookup from ROI engine output
function _buildROIIndex(roiResult) {
  const index = {};
  if (!roiResult?.education_options) return index;

  for (const option of roiResult.education_options) {
    for (const career of (option.matched_careers ?? [])) {
      const key = career.toLowerCase();
      // Keep best ROI entry per career
      if (!index[key] || option.roi_score > index[key].roi_score) {
        index[key] = { path: option.path, roi_level: option.roi_level, roi_score: option.roi_score };
      }
    }
  }
  return index;
}

module.exports = { simulate, CAREER_BENCHMARKS };









