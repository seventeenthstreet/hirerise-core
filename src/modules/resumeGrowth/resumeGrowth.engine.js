'use strict';

/**
 * resumeGrowth.engine.js
 * Pure logic — no DB, no I/O, fully testable in isolation.
 */

// ─── Level thresholds ─────────────────────────────────────────

const LEVEL_THRESHOLDS = [
  { level: 'L1', minYears: 0,  minSkillCoverage: 0  },
  { level: 'L2', minYears: 2,  minSkillCoverage: 40 },
  { level: 'L3', minYears: 5,  minSkillCoverage: 65 },
  { level: 'L4', minYears: 8,  minSkillCoverage: 80 },
  { level: 'L5', minYears: 12, minSkillCoverage: 90 },
];

const PROMOTION_READINESS_BANDS = [
  { min: 80, label: 'High' },
  { min: 55, label: 'Moderate' },
  { min: 0,  label: 'Early' },
];

const DEGREE_WEIGHTS = {
  phd:         100,
  doctorate:   100,
  masters:     85,
  mba:         85,
  bachelor:    65,
  associate:   45,
  diploma:     35,
  certificate: 30,
};

// ─── Skill Coverage ───────────────────────────────────────────

function calculateSkillCoverage(candidateSkills, requiredSkills, preferredSkills = []) {
  if (!requiredSkills.length) return 50;

  const candidateSet = new Set(candidateSkills.map(s => s.toLowerCase()));

  const requiredHits  = requiredSkills.filter(s => candidateSet.has(s.toLowerCase())).length;
  const requiredScore = (requiredHits / requiredSkills.length) * 80;

  const preferredHits  = preferredSkills.filter(s => candidateSet.has(s.toLowerCase())).length;
  const preferredScore = preferredSkills.length
    ? (preferredHits / preferredSkills.length) * 20
    : 0;

  return Math.round(Math.min(100, requiredScore + preferredScore));
}

function findSkillGaps(candidateSkills, requiredSkills) {
  const candidateSet = new Set(candidateSkills.map(s => s.toLowerCase()));
  return requiredSkills.filter(s => !candidateSet.has(s.toLowerCase()));
}

// ─── Experience Depth ─────────────────────────────────────────

function calculateExperienceDepth(experience, totalYears, roleContext) {
  const minYears   = roleContext.min_experience_years   || 0;
  const idealYears = roleContext.ideal_experience_years || minYears + 3;

  let yearsScore;

  if (totalYears >= idealYears) {
    yearsScore = 50;
  } else if (totalYears >= minYears) {
    yearsScore = ((totalYears - minYears) / (idealYears - minYears || 1)) * 50;
  } else {
    yearsScore = (totalYears / (minYears || 1)) * 30;
  }

  const enriched = experience.filter(
    e => e.responsibilities?.length >= 2 || e.achievements?.length >= 1
  ).length;

  const richnessScore = experience.length
    ? (enriched / experience.length) * 30
    : 0;

  const avgMonths = experience.length
    ? experience.reduce((s, e) => s + (e.duration_months || 0), 0) / experience.length
    : 0;

  const tenureScore = Math.min(20, (avgMonths / 24) * 20);

  return Math.round(Math.min(100, yearsScore + richnessScore + tenureScore));
}

function attachDurations(experience) {
  return experience.map(exp => {
    const start = parseDate(exp.start_date);
    const end   = exp.end_date ? parseDate(exp.end_date) : new Date();
    const months = start ? Math.max(0, monthDiff(start, end)) : 0;
    return { ...exp, duration_months: months };
  });
}

function parseDate(str) {
  if (!str) return null;
  if (str.toLowerCase() === 'present') return new Date();
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

function monthDiff(start, end) {
  return (end.getFullYear() - start.getFullYear()) * 12 +
         (end.getMonth() - start.getMonth());
}

// ─── Education Alignment ──────────────────────────────────────

function calculateEducationAlignment(education, certifications) {
  let best = 0;

  for (const edu of education) {
    const degree = (edu.degree || '').toLowerCase();

    for (const [key, pts] of Object.entries(DEGREE_WEIGHTS)) {
      if (degree.includes(key)) {
        best = Math.max(best, pts);
        break;
      }
    }
  }

  if (best === 0 && education.length) best = 25;
  if (best === 0) best = 10;

  const certBonus = Math.min(20, certifications.length * 5);

  return Math.round(Math.min(100, best + certBonus));
}

// ─── Level Estimation ─────────────────────────────────────────

function estimateLevel(totalYears, skillCoverage) {
  let level = LEVEL_THRESHOLDS[0].level;

  for (const band of LEVEL_THRESHOLDS) {
    if (totalYears >= band.minYears &&
        skillCoverage >= band.minSkillCoverage) {
      level = band.level;
    }
  }

  return level;
}

function estimateLevelIfImproved(totalYears, currentCoverage) {
  const projectedCoverage = Math.min(100, currentCoverage + 25);
  return estimateLevel(totalYears, projectedCoverage);
}

// ─── Promotion Readiness ──────────────────────────────────────

function assessPromotionReadiness(skillCoverage, experienceDepth, educationAlignment) {
  const composite = Math.round(
    skillCoverage      * 0.45 +
    experienceDepth    * 0.35 +
    educationAlignment * 0.20
  );

  const band = PROMOTION_READINESS_BANDS.find(b => composite >= b.min);

  return band ? band.label : 'Early';
}

// ─── Export (CommonJS) ────────────────────────────────────────

module.exports = {
  attachDurations,
  calculateSkillCoverage,
  findSkillGaps,
  calculateExperienceDepth,
  calculateEducationAlignment,
  estimateLevel,
  estimateLevelIfImproved,
  assessPromotionReadiness,
};
