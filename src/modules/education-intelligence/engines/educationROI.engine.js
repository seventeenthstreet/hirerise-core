'use strict';

/**
 * engines/educationROI.engine.js
 *
 * Production-hardened Education ROI Engine.
 */

const ENGINE_VERSION = '1.1.0';

const VALID_STREAMS = new Set([
  'engineering',
  'medical',
  'commerce',
  'humanities'
]);

const EDUCATION_PATHS = [
  {
    path: 'BTech Computer Science',
    duration_years: 4,
    average_cost: 800000,
    average_salary: 600000,
    demand_score: 0.95,
    streams: ['engineering'],
    career_keywords: [
      'software',
      'engineer',
      'ai',
      'ml',
      'data',
      'cyber',
      'systems',
      'architect'
    ]
  },
  {
    path: 'BCA → MCA',
    duration_years: 5,
    average_cost: 500000,
    average_salary: 550000,
    demand_score: 0.85,
    streams: ['engineering'],
    career_keywords: [
      'software',
      'engineer',
      'data',
      'analyst',
      'systems'
    ]
  },
  {
    path: 'BTech IT',
    duration_years: 4,
    average_cost: 700000,
    average_salary: 580000,
    demand_score: 0.88,
    streams: ['engineering'],
    career_keywords: [
      'software',
      'engineer',
      'cyber',
      'systems',
      'data'
    ]
  },
  {
    path: 'BSc Computer Science → MSc',
    duration_years: 5,
    average_cost: 400000,
    average_salary: 520000,
    demand_score: 0.8,
    streams: ['engineering'],
    career_keywords: [
      'software',
      'ai',
      'ml',
      'data',
      'research'
    ]
  },
  {
    path: 'Diploma in CS + BTech (Lateral)',
    duration_years: 4,
    average_cost: 350000,
    average_salary: 480000,
    demand_score: 0.72,
    streams: ['engineering'],
    career_keywords: [
      'software',
      'engineer',
      'systems'
    ]
  },

  {
    path: 'MBBS',
    duration_years: 5.5,
    average_cost: 6000000,
    average_salary: 800000,
    demand_score: 0.9,
    streams: ['medical'],
    career_keywords: ['doctor', 'mbbs', 'medical']
  },
  {
    path: 'MBBS → MD Specialisation',
    duration_years: 8,
    average_cost: 8000000,
    average_salary: 1800000,
    demand_score: 0.92,
    streams: ['medical'],
    career_keywords: ['doctor', 'mbbs', 'medical']
  },
  {
    path: 'BPharm → MPharm',
    duration_years: 5,
    average_cost: 800000,
    average_salary: 500000,
    demand_score: 0.75,
    streams: ['medical'],
    career_keywords: ['pharmacist']
  },
  {
    path: 'BSc Biotechnology → MSc',
    duration_years: 5,
    average_cost: 600000,
    average_salary: 450000,
    demand_score: 0.7,
    streams: ['medical'],
    career_keywords: ['biomedical', 'research']
  },
  {
    path: 'BAMS (Ayurveda)',
    duration_years: 5.5,
    average_cost: 1500000,
    average_salary: 450000,
    demand_score: 0.62,
    streams: ['medical'],
    career_keywords: ['doctor', 'medical']
  },

  {
    path: 'BCom → CA',
    duration_years: 5,
    average_cost: 400000,
    average_salary: 800000,
    demand_score: 0.88,
    streams: ['commerce'],
    career_keywords: [
      'chartered',
      'accountant',
      'finance'
    ]
  },
  {
    path: 'BBA → MBA Finance',
    duration_years: 5,
    average_cost: 1200000,
    average_salary: 900000,
    demand_score: 0.85,
    streams: ['commerce'],
    career_keywords: [
      'investment',
      'banker',
      'finance',
      'entrepreneur',
      'marketing'
    ]
  },
  {
    path: 'BCom Honours',
    duration_years: 3,
    average_cost: 300000,
    average_salary: 450000,
    demand_score: 0.7,
    streams: ['commerce'],
    career_keywords: [
      'chartered',
      'accountant',
      'finance'
    ]
  },
  {
    path: 'BBA → MBA Marketing',
    duration_years: 5,
    average_cost: 1200000,
    average_salary: 850000,
    demand_score: 0.82,
    streams: ['commerce'],
    career_keywords: [
      'marketing',
      'entrepreneur'
    ]
  },
  {
    path: 'Integrated MBA (5-Year)',
    duration_years: 5,
    average_cost: 1500000,
    average_salary: 950000,
    demand_score: 0.83,
    streams: ['commerce', 'humanities'],
    career_keywords: [
      'entrepreneur',
      'marketing',
      'investment',
      'banker'
    ]
  },

  {
    path: 'BA LLB (5-Year Integrated)',
    duration_years: 5,
    average_cost: 600000,
    average_salary: 600000,
    demand_score: 0.8,
    streams: ['humanities'],
    career_keywords: [
      'lawyer',
      'law',
      'civil services'
    ]
  },
  {
    path: 'BA → MA → Civil Services',
    duration_years: 7,
    average_cost: 350000,
    average_salary: 700000,
    demand_score: 0.85,
    streams: ['humanities'],
    career_keywords: [
      'civil services',
      'ias',
      'ips'
    ]
  },
  {
    path: 'BA Journalism → Mass Communication',
    duration_years: 4,
    average_cost: 400000,
    average_salary: 420000,
    demand_score: 0.65,
    streams: ['humanities'],
    career_keywords: [
      'journalist',
      'writer',
      'communication'
    ]
  },
  {
    path: 'BDes (UX/Product Design)',
    duration_years: 4,
    average_cost: 900000,
    average_salary: 650000,
    demand_score: 0.82,
    streams: ['humanities', 'engineering'],
    career_keywords: ['ux', 'designer', 'design']
  },
  {
    path: 'BA Psychology → MA',
    duration_years: 5,
    average_cost: 350000,
    average_salary: 380000,
    demand_score: 0.6,
    streams: ['humanities'],
    career_keywords: [
      'communication',
      'marketing',
      'journalist'
    ]
  }
];

function classifyROI(score) {
  if (score >= 80) return 'Very High';
  if (score >= 60) return 'High';
  if (score >= 30) return 'Moderate';
  return 'Low';
}

function normalizeDemand(value, fallback) {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) return fallback;

  return numeric > 1
    ? clamp(numeric / 100, 0, 1)
    : clamp(numeric, 0, 1);
}

async function analyze(
  careerResult,
  recommendedStream,
  marketScores = {}
) {
  const topCareers =
    careerResult?.top_careers || [];

  if (!topCareers.length) {
    return emptyResult();
  }

  const validStream = VALID_STREAMS.has(
    recommendedStream
  )
    ? recommendedStream
    : null;

  const allCareerNames = topCareers.map((c) =>
    c.career.toLowerCase()
  );

  let relevantPaths = EDUCATION_PATHS.filter(
    (path) => {
      const streamMatch = validStream
        ? path.streams.includes(validStream)
        : false;

      const careerMatch =
        path.career_keywords.some((keyword) =>
          allCareerNames.some((career) =>
            career.includes(keyword)
          )
        );

      return streamMatch || careerMatch;
    }
  );

  if (!relevantPaths.length) {
    relevantPaths = EDUCATION_PATHS.slice(0, 5);
  }

  const rawScores = relevantPaths.map((path) => {
    const matchedCareers = topCareers.filter(
      (career) =>
        path.career_keywords.some((keyword) =>
          career.career
            .toLowerCase()
            .includes(keyword)
        )
    );

    const bestProbability =
      matchedCareers.length > 0
        ? Math.max(
            ...matchedCareers.map(
              (c) => c.probability
            )
          )
        : topCareers[
            topCareers.length - 1
          ]?.probability ?? 50;

    const bestMatchedCareer =
      matchedCareers[0]?.career || null;

    const marketScore = bestMatchedCareer
      ? marketScores?.[bestMatchedCareer]
      : null;

    const effectiveDemand =
      marketScore != null
        ? path.demand_score * 0.4 +
          normalizeDemand(
            marketScore.demand_score,
            path.demand_score
          ) *
            0.6
        : path.demand_score;

    const liveSalary = Number(
      marketScore?.avg_entry_salary
    );

    const salary = Number.isFinite(liveSalary)
      ? path.average_salary * 0.5 +
        liveSalary * 0.5
      : path.average_salary;

    const rawROI =
      (salary *
        (bestProbability / 100) *
        effectiveDemand) /
      path.average_cost;

    return {
      path: path.path,
      duration_years: path.duration_years,
      estimated_cost: path.average_cost,
      expected_salary: Math.round(salary),
      matched_careers: matchedCareers.map(
        (c) => c.career
      ),
      raw_roi: rawROI
    };
  });

  const maxRaw = Math.max(
    ...rawScores.map((s) => s.raw_roi),
    0.001
  );
  const minRaw = Math.min(
    ...rawScores.map((s) => s.raw_roi)
  );

  const education_options = rawScores
    .map((score) => {
      const normalized =
        maxRaw === minRaw
          ? 50
          : ((score.raw_roi - minRaw) /
              (maxRaw - minRaw)) *
            100;

      const roi_score = Math.round(
        clamp(normalized, 0, 100)
      );

      return {
        path: score.path,
        duration_years:
          score.duration_years,
        estimated_cost:
          score.estimated_cost,
        expected_salary:
          score.expected_salary,
        roi_score,
        roi_level: classifyROI(roi_score),
        matched_careers:
          score.matched_careers
      };
    })
    .sort((a, b) => {
      if (b.roi_score !== a.roi_score) {
        return b.roi_score - a.roi_score;
      }

      return a.path.localeCompare(b.path);
    });

  return {
    education_options,
    engine_version: ENGINE_VERSION
  };
}

function emptyResult() {
  return {
    education_options: [],
    engine_version: ENGINE_VERSION
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

module.exports = {
  analyze,
  EDUCATION_PATHS,
  classifyROI
};