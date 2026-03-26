'use strict';

/**
 * engines/educationROI.engine.js
 *
 * Education ROI Engine (ERE)
 *
 * Estimates the financial return of education paths for a student
 * based on their top career predictions and probability scores.
 *
 * Formula:
 *   raw_roi = (expected_salary × career_probability × demand_score) / education_cost
 *   roi_score = normalize(raw_roi) → 0–100
 *
 * ROI Classification:
 *   0–30   → Low ROI
 *   30–60  → Moderate ROI
 *   60–80  → High ROI
 *   80–100 → Very High ROI
 *
 * Input:
 *   careerResult — output of CareerSuccessEngine ({ top_careers, all_careers })
 *   streamResult — output of StreamIntelligenceEngine ({ recommended_stream })
 *
 * Output:
 * {
 *   education_options: [
 *     {
 *       path:            'BCA → MCA',
 *       duration_years:  5,
 *       estimated_cost:  500000,
 *       expected_salary: 550000,
 *       roi_score:       88,
 *       roi_level:       'Very High',
 *       matched_careers: ['Software Engineer', 'Data Scientist'],
 *     },
 *     ...
 *   ],
 *   engine_version: '1.0.0',
 * }
 */

const ENGINE_VERSION = '1.0.0';

// ─── Education Path Dataset ───────────────────────────────────────────────────
//
// Each path defines:
//   average_cost    — total course cost in INR
//   average_salary  — expected starting annual salary in INR
//   duration_years  — course duration
//   demand_score    — market demand signal 0–1 (manually curated)
//   streams         — relevant academic streams
//   career_keywords — keyword matches to CareerSuccessEngine career names

const EDUCATION_PATHS = [
  // ── Engineering / Technology ──────────────────────────────────────────────
  {
    path:             'BTech Computer Science',
    duration_years:   4,
    average_cost:     800000,
    average_salary:   600000,
    demand_score:     0.95,
    streams:          ['engineering'],
    career_keywords:  ['software', 'engineer', 'ai', 'ml', 'data', 'cyber', 'systems', 'architect'],
  },
  {
    path:             'BCA → MCA',
    duration_years:   5,
    average_cost:     500000,
    average_salary:   550000,
    demand_score:     0.85,
    streams:          ['engineering'],
    career_keywords:  ['software', 'engineer', 'data', 'analyst', 'systems'],
  },
  {
    path:             'BTech IT',
    duration_years:   4,
    average_cost:     700000,
    average_salary:   580000,
    demand_score:     0.88,
    streams:          ['engineering'],
    career_keywords:  ['software', 'engineer', 'cyber', 'systems', 'data'],
  },
  {
    path:             'BSc Computer Science → MSc',
    duration_years:   5,
    average_cost:     400000,
    average_salary:   520000,
    demand_score:     0.80,
    streams:          ['engineering'],
    career_keywords:  ['software', 'ai', 'ml', 'data', 'research'],
  },
  {
    path:             'Diploma in CS + BTech (Lateral)',
    duration_years:   4,
    average_cost:     350000,
    average_salary:   480000,
    demand_score:     0.72,
    streams:          ['engineering'],
    career_keywords:  ['software', 'engineer', 'systems'],
  },

  // ── Medical / Science ─────────────────────────────────────────────────────
  {
    path:             'MBBS',
    duration_years:   5.5,
    average_cost:     6000000,
    average_salary:   800000,
    demand_score:     0.90,
    streams:          ['medical'],
    career_keywords:  ['doctor', 'mbbs', 'medical'],
  },
  {
    path:             'MBBS → MD Specialisation',
    duration_years:   8,
    average_cost:     8000000,
    average_salary:   1800000,
    demand_score:     0.92,
    streams:          ['medical'],
    career_keywords:  ['doctor', 'mbbs', 'medical'],
  },
  {
    path:             'BPharm → MPharm',
    duration_years:   5,
    average_cost:     800000,
    average_salary:   500000,
    demand_score:     0.75,
    streams:          ['medical'],
    career_keywords:  ['pharmacist'],
  },
  {
    path:             'BSc Biotechnology → MSc',
    duration_years:   5,
    average_cost:     600000,
    average_salary:   450000,
    demand_score:     0.70,
    streams:          ['medical'],
    career_keywords:  ['biomedical', 'research'],
  },
  {
    path:             'BAMS (Ayurveda)',
    duration_years:   5.5,
    average_cost:     1500000,
    average_salary:   450000,
    demand_score:     0.62,
    streams:          ['medical'],
    career_keywords:  ['doctor', 'medical'],
  },

  // ── Commerce / Business ────────────────────────────────────────────────────
  {
    path:             'BCom → CA',
    duration_years:   5,
    average_cost:     400000,
    average_salary:   800000,
    demand_score:     0.88,
    streams:          ['commerce'],
    career_keywords:  ['chartered', 'accountant', 'finance'],
  },
  {
    path:             'BBA → MBA Finance',
    duration_years:   5,
    average_cost:     1200000,
    average_salary:   900000,
    demand_score:     0.85,
    streams:          ['commerce'],
    career_keywords:  ['investment', 'banker', 'finance', 'entrepreneur', 'marketing'],
  },
  {
    path:             'BCom Honours',
    duration_years:   3,
    average_cost:     300000,
    average_salary:   450000,
    demand_score:     0.70,
    streams:          ['commerce'],
    career_keywords:  ['chartered', 'accountant', 'finance'],
  },
  {
    path:             'BBA → MBA Marketing',
    duration_years:   5,
    average_cost:     1200000,
    average_salary:   850000,
    demand_score:     0.82,
    streams:          ['commerce'],
    career_keywords:  ['marketing', 'entrepreneur'],
  },
  {
    path:             'Integrated MBA (5-Year)',
    duration_years:   5,
    average_cost:     1500000,
    average_salary:   950000,
    demand_score:     0.83,
    streams:          ['commerce', 'humanities'],
    career_keywords:  ['entrepreneur', 'marketing', 'investment', 'banker'],
  },

  // ── Humanities / Law ──────────────────────────────────────────────────────
  {
    path:             'BA LLB (5-Year Integrated)',
    duration_years:   5,
    average_cost:     600000,
    average_salary:   600000,
    demand_score:     0.80,
    streams:          ['humanities'],
    career_keywords:  ['lawyer', 'law', 'civil services'],
  },
  {
    path:             'BA → MA → Civil Services',
    duration_years:   7,
    average_cost:     350000,
    average_salary:   700000,
    demand_score:     0.85,
    streams:          ['humanities'],
    career_keywords:  ['civil services', 'ias', 'ips'],
  },
  {
    path:             'BA Journalism → Mass Communication',
    duration_years:   4,
    average_cost:     400000,
    average_salary:   420000,
    demand_score:     0.65,
    streams:          ['humanities'],
    career_keywords:  ['journalist', 'writer', 'communication'],
  },
  {
    path:             'BDes (UX/Product Design)',
    duration_years:   4,
    average_cost:     900000,
    average_salary:   650000,
    demand_score:     0.82,
    streams:          ['humanities', 'engineering'],
    career_keywords:  ['ux', 'designer', 'design'],
  },
  {
    path:             'BA Psychology → MA',
    duration_years:   5,
    average_cost:     350000,
    average_salary:   380000,
    demand_score:     0.60,
    streams:          ['humanities'],
    career_keywords:  ['communication', 'marketing', 'journalist'],
  },
];

// ─── ROI Classification ───────────────────────────────────────────────────────

function classifyROI(score) {
  if (score >= 80) return 'Very High';
  if (score >= 60) return 'High';
  if (score >= 30) return 'Moderate';
  return 'Low';
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Compute ROI scores for education paths relevant to the student.
 *
 * @param {object} careerResult — output from CareerSuccessEngine
 * @param {string} recommendedStream — output from StreamIntelligenceEngine
 * @returns {EduROIResult}
 */
async function analyze(careerResult, recommendedStream, marketScores = {}) {
  if (!careerResult || !careerResult.top_careers?.length) {
    return _emptyResult();
  }

  const topCareers = careerResult.top_careers; // [{ career, probability }]

  // ── 1. Filter paths relevant to the student's stream ─────────────────────
  const allCareerNames = topCareers.map(c => c.career.toLowerCase());

  const relevantPaths = EDUCATION_PATHS.filter(p => {
    const streamMatch  = p.streams.includes(recommendedStream);
    const careerMatch  = p.career_keywords.some(kw =>
      allCareerNames.some(career => career.includes(kw))
    );
    return streamMatch || careerMatch;
  });

  if (relevantPaths.length === 0) {
    relevantPaths.push(...EDUCATION_PATHS.slice(0, 5));
  }

  // ── 2. Score each path ────────────────────────────────────────────────────
  const rawScores = relevantPaths.map(path => {
    const matchedCareers = topCareers.filter(c =>
      path.career_keywords.some(kw => c.career.toLowerCase().includes(kw))
    );

    const bestProbability = matchedCareers.length > 0
      ? Math.max(...matchedCareers.map(c => c.probability))
      : topCareers[topCareers.length - 1]?.probability ?? 50;

    const probFactor = bestProbability / 100;

    // Blend static demand with live LMI signal for best matched career
    const bestMatchedCareer = matchedCareers[0]?.career ?? null;
    const lmiScore   = bestMatchedCareer ? marketScores[bestMatchedCareer] : null;
    const liveDemand = lmiScore ? lmiScore.demand_score / 100 : null;
    const effectiveDemand = liveDemand != null
      ? (path.demand_score * 0.4 + liveDemand * 0.6)
      : path.demand_score;

    // Use live salary data if available
    const liveSalary = lmiScore?.avg_entry_salary ?? null;
    const salary = liveSalary ? (path.average_salary * 0.5 + liveSalary * 0.5) : path.average_salary;

    const rawROI = (salary * probFactor * effectiveDemand) / path.average_cost;
    const matchedCareerNames = matchedCareers.map(c => c.career);

    return {
      path:             path.path,
      duration_years:   path.duration_years,
      estimated_cost:   path.average_cost,
      expected_salary:  Math.round(salary),
      demand_score:     effectiveDemand,
      matched_careers:  matchedCareerNames,
      _raw_roi:         rawROI,
    };
  });

  // ── 3. Normalise raw ROI to 0–100 ────────────────────────────────────────
  const maxRaw = Math.max(...rawScores.map(s => s._raw_roi), 0.001);
  const minRaw = Math.min(...rawScores.map(s => s._raw_roi));

  const scored = rawScores.map(s => {
    // Min-max normalisation → 0–100
    const normalised = maxRaw === minRaw
      ? 50
      : ((s._raw_roi - minRaw) / (maxRaw - minRaw)) * 100;

    const roi_score = Math.round(_clamp(normalised, 0, 100));

    return {
      path:            s.path,
      duration_years:  s.duration_years,
      estimated_cost:  s.estimated_cost,
      expected_salary: s.expected_salary,
      roi_score,
      roi_level:       classifyROI(roi_score),
      matched_careers: s.matched_careers,
    };
  });

  // ── 4. Sort by roi_score descending ──────────────────────────────────────
  scored.sort((a, b) => b.roi_score - a.roi_score);

  return {
    education_options: scored,
    engine_version:    ENGINE_VERSION,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _emptyResult() {
  return { education_options: [], engine_version: ENGINE_VERSION };
}

function _clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

module.exports = { analyze, EDUCATION_PATHS, classifyROI };









