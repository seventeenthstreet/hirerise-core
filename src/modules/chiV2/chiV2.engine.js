'use strict';

/**
 * chiV2.engine.js — Career Health Index v2
 *
 * Pure deterministic scoring engine. No AI calls. No external dependencies.
 * All data sourced exclusively from Firestore graph collections:
 *
 *   roles               — role metadata
 *   role_skills         — required skills per role (with importance_weight)
 *   role_transitions    — career graph edges (with years_required)
 *   skill_relationships — skill adjacency graph
 *   role_education      — education requirements per role
 *   role_salary_market  — salary benchmarks per role
 *
 * CHI v2 Components & Weights:
 *   Skill Match Score      30%  — weighted coverage of required skills
 *   Skill Depth Score      15%  — proficiency level of matched skills
 *   Career Distance Score  20%  — graph-path distance from current → target role
 *   Experience Score       15%  — user years vs expected path years
 *   Education Score        10%  — education level vs role requirements
 *   Market Salary Score    10%  — user salary vs market median
 *
 * SECURITY: Read-only Firestore access. No writes. No auth mutations.
 */

const { db } = require('../../config/supabase');
const logger  = require('../../utils/logger');

// ─── Constants ────────────────────────────────────────────────────────────────

const WEIGHTS = Object.freeze({
  skillMatch:      0.30,
  skillDepth:      0.15,
  careerDistance:  0.20,
  experience:      0.15,
  education:       0.10,
  marketSalary:    0.10,
});

// Validate weights sum to 1.0
const WEIGHT_SUM = Object.values(WEIGHTS).reduce((s, w) => s + w, 0);
if (Math.abs(WEIGHT_SUM - 1.0) > 0.0001) {
  throw new Error(`CHI v2 weights must sum to 1.0 — current sum: ${WEIGHT_SUM}`);
}

const SKILL_LEVEL_SCORES = Object.freeze({
  beginner:     40,
  intermediate: 70,
  advanced:     90,
  expert:       100,
});

const CAREER_DISTANCE_PENALTY_PER_STEP = 15;
const SALARY_SCORE_MIN  = 30;
const SALARY_SCORE_MAX  = 100;
const BFS_MAX_DEPTH     = 10;

// ─── Firestore Helpers ────────────────────────────────────────────────────────

/**
 * Resolve a role document by either Firestore doc ID or role_id field.
 * Tries doc lookup first (O(1)), then falls back to a where-query.
 */
async function resolveRoleId(identifier) {
  if (!identifier) return null;

  // Direct doc lookup
  const direct = await db.collection('roles').doc(identifier).get();
  if (direct.exists) return identifier;

  // Field-based lookup (role_id field may differ from doc ID)
  const snap = await db.collection('roles')
    .where('role_id', '==', identifier)
    .limit(1)
    .get();

  if (!snap.empty) return snap.docs[0].id;

  // Fuzzy name match as last resort
  const nameSnap = await db.collection('roles')
    .where('role_name', '==', identifier)
    .limit(1)
    .get();

  return nameSnap.empty ? null : nameSnap.docs[0].id;
}

// ─── Component 1: Skill Match ─────────────────────────────────────────────────

/**
 * Calculates weighted skill coverage of user skills vs role requirements.
 *
 * @param {string}   roleDocId        - Firestore doc ID of target role
 * @param {string[]} userSkills       - User's skill names or IDs
 * @returns {{ score: number, matched: string[], missing: string[], totalWeight: number }}
 */
async function computeSkillMatch(roleDocId, userSkills) {
  const snap = await db.collection('role_skills')
    .where('role_id', '==', roleDocId)
    .get();

  if (snap.empty) {
    logger.warn('[CHIv2] No role_skills found for role', { roleDocId });
    return { score: 50, matched: [], missing: [], totalWeight: 0 };
  }

  // Build a normalised set of user skill identifiers for O(1) lookup
  const userSkillSet = new Set(
    (userSkills || []).map(s => String(s).toLowerCase().trim())
  );

  let weightedMatchSum = 0;
  let totalWeight      = 0;
  const matched        = [];
  const missing        = [];

  for (const doc of snap.docs) {
    const data   = doc.data();
    const weight = Number(data.importance_weight) || 1;
    const skillId   = String(data.skill_id   || '').toLowerCase().trim();
    const skillName = String(data.skill_name || data.skill_id || '').toLowerCase().trim();

    totalWeight += weight;

    const isMatched = userSkillSet.has(skillId) || userSkillSet.has(skillName);

    if (isMatched) {
      weightedMatchSum += weight;
      matched.push(data.skill_name || data.skill_id);
    } else {
      missing.push(data.skill_name || data.skill_id);
    }
  }

  const score = totalWeight > 0
    ? Math.round((weightedMatchSum / totalWeight) * 100)
    : 50;

  return { score, matched, missing, totalWeight };
}

// ─── Component 2: Skill Depth ─────────────────────────────────────────────────

/**
 * Averages proficiency scores of only the skills the user has matched.
 *
 * @param {string[]} matchedSkills   - Skill names/IDs that were matched
 * @param {Object[]} skillLevels     - Array of { skill, level } from user profile
 * @returns {{ score: number, levelMap: Object }}
 */
function computeSkillDepth(matchedSkills, skillLevels) {
  if (!matchedSkills || matchedSkills.length === 0) {
    return { score: 50, levelMap: {} };
  }

  // Build level lookup from user profile
  const levelMap = {};
  (skillLevels || []).forEach(entry => {
    if (!entry) return;
    const skill = String(entry.skill || entry.skill_name || entry.id || '').toLowerCase().trim();
    const level = String(entry.level || entry.proficiency || '').toLowerCase().trim();
    if (skill) levelMap[skill] = level;
  });

  const matchedNorm = matchedSkills.map(s => String(s).toLowerCase().trim());

  let total = 0;
  let count = 0;

  for (const skill of matchedNorm) {
    const level = levelMap[skill] ?? 'intermediate';
    const numeric = SKILL_LEVEL_SCORES[level] ?? SKILL_LEVEL_SCORES.intermediate;
    total += numeric;
    count++;
  }

  const score = count > 0 ? Math.round(total / count) : 50;
  return { score, levelMap };
}

// ─── Component 3 & 4: Career Distance + Experience (BFS) ─────────────────────

/**
 * BFS over role_transitions to find the shortest path from currentRoleId
 * to targetRoleId. Returns the path and total years_required.
 *
 * Each call to db.collection is scoped to outgoing edges of a single role,
 * keeping reads bounded (O(nodes × avg_degree)).
 *
 * @param {string} currentRoleId
 * @param {string} targetRoleId
 * @returns {{ found: boolean, steps: number, totalYears: number, path: string[] }}
 */
async function bfsCareerPath(currentRoleId, targetRoleId) {
  if (currentRoleId === targetRoleId) {
    return { found: true, steps: 0, totalYears: 0, path: [currentRoleId] };
  }

  // BFS state: queue holds [roleId, pathSoFar, yearsAccumulated]
  const visited = new Set([currentRoleId]);
  const queue   = [{ id: currentRoleId, path: [currentRoleId], years: 0 }];

  while (queue.length > 0) {
    const { id: current, path, years } = queue.shift();

    if (path.length > BFS_MAX_DEPTH) continue;

    const snap = await db.collection('role_transitions')
      .where('from_role_id', '==', current)
      .get();

    for (const doc of snap.docs) {
      const data   = doc.data();
      const nextId = data.to_role_id;
      if (!nextId || visited.has(nextId)) continue;

      const stepYears  = Number(data.years_required) || 0;
      const newYears   = years + stepYears;
      const newPath    = [...path, nextId];

      if (nextId === targetRoleId) {
        return {
          found:      true,
          steps:      newPath.length - 1,
          totalYears: newYears,
          path:       newPath,
        };
      }

      visited.add(nextId);
      queue.push({ id: nextId, path: newPath, years: newYears });
    }
  }

  return { found: false, steps: BFS_MAX_DEPTH, totalYears: 0, path: [] };
}

/**
 * Career Distance Score:  max(100 - steps * 15, 0)
 * Experience Score:       min((userYears / expectedYears) * 100, 100)
 */
function computeCareerDistanceScore(steps) {
  return Math.max(100 - steps * CAREER_DISTANCE_PENALTY_PER_STEP, 0);
}

function computeExperienceScore(userYears, expectedYears) {
  if (!expectedYears || expectedYears <= 0) return 70; // neutral fallback
  return Math.min(Math.round((userYears / expectedYears) * 100), 100);
}

// ─── Component 5: Education Score ────────────────────────────────────────────

const EDUCATION_RANK = Object.freeze({
  none:         0,
  high_school:  1,
  diploma:      2,
  bachelors:    3,
  masters:      4,
  mba:          4,
  phd:          5,
});

/**
 * Matches user education level against role_education requirements.
 * Returns match_score if exact match (or over-qualified), else match_score * 0.6.
 */
async function computeEducationScore(roleDocId, userEducationLevel) {
  const snap = await db.collection('role_education')
    .where('role_id', '==', roleDocId)
    .get();

  if (snap.empty) return 70; // no requirement = neutral score

  // Pick the best match: prefer exact match, then closest level
  const userRank = EDUCATION_RANK[String(userEducationLevel || '').toLowerCase()] ?? 2;

  let bestScore = 0;

  for (const doc of snap.docs) {
    const data          = doc.data();
    const reqLevel      = String(data.education_level || '').toLowerCase();
    const reqRank       = EDUCATION_RANK[reqLevel] ?? 2;
    const matchScore    = Number(data.match_score) || 70;

    if (userRank >= reqRank) {
      // Meets or exceeds requirement
      bestScore = Math.max(bestScore, matchScore);
    } else {
      // Below requirement — apply penalty
      bestScore = Math.max(bestScore, Math.round(matchScore * 0.6));
    }
  }

  return Math.min(bestScore, 100);
}

// ─── Component 6: Market Salary Score ────────────────────────────────────────

/**
 * Compares user salary to market median for the target role.
 * Score clamped between SALARY_SCORE_MIN (30) and SALARY_SCORE_MAX (100).
 */
async function computeMarketSalaryScore(roleDocId, userSalary) {
  if (!userSalary || userSalary <= 0) return 50; // no salary data = neutral

  const snap = await db.collection('role_salary_market')
    .where('role_id', '==', roleDocId)
    .limit(5)
    .get();

  if (snap.empty) return 50;

  // Average the median salaries across available market records
  const records = snap.docs.map(d => d.data()).filter(d => d.median_salary > 0);
  if (records.length === 0) return 50;

  const avgMedian = records.reduce((sum, r) => sum + Number(r.median_salary), 0) / records.length;
  const raw       = Math.round((userSalary / avgMedian) * 100);

  return Math.min(Math.max(raw, SALARY_SCORE_MIN), SALARY_SCORE_MAX);
}

// ─── Insights Engine ──────────────────────────────────────────────────────────

/**
 * Generates actionable insights from scoring breakdown + gaps.
 */
function generateInsights({ breakdown, missingSkills, steps, expectedYears, userYears, educationScore, salaryScore }) {
  const insights = [];

  // Skill coverage insights
  if (breakdown.skill_match < 50 && missingSkills.length > 0) {
    const topMissing = missingSkills.slice(0, 3).join(', ');
    insights.push(`Improve skill coverage — key missing skills: ${topMissing}`);
  } else if (breakdown.skill_match < 75 && missingSkills.length > 0) {
    insights.push(`Learn ${missingSkills[0]} to improve skill coverage to the next level`);
  }

  // Skill depth insights
  if (breakdown.skill_depth < 60) {
    insights.push('Deepen proficiency in your matched skills — aim for Advanced level or higher');
  }

  // Career distance insights
  if (steps === 0) {
    insights.push('You are already in the target role — focus on skill depth and market positioning');
  } else if (steps === 1) {
    insights.push('You are one transition away from your target role');
  } else if (steps > 1) {
    insights.push(`You are approximately ${steps} career transitions away from the target role`);
  }

  // Experience insights
  if (expectedYears > 0 && userYears < expectedYears) {
    const gap = Math.round(expectedYears - userYears);
    insights.push(`You need approximately ${gap} more year${gap !== 1 ? 's' : ''} of experience for this career path`);
  } else if (expectedYears > 0 && userYears >= expectedYears) {
    insights.push('Your experience level meets the expected requirements for this career path');
  }

  // Education insights
  if (educationScore < 60) {
    insights.push('Your education level is below the typical requirement — consider upskilling or certifications');
  } else if (educationScore >= 85) {
    insights.push('Your education matches or exceeds market expectations for this role');
  }

  // Salary insights
  if (salaryScore < 50) {
    insights.push('Your current salary is below market median — this role offers strong salary growth potential');
  } else if (salaryScore >= 90) {
    insights.push('Your salary is at or above market median for this role');
  }

  // Fallback
  if (insights.length === 0) {
    insights.push('Your profile is well-aligned with the target role — continue building depth');
  }

  return insights;
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * calculateCHI(profile) → CHI v2 result
 *
 * @param {Object} profile
 * @param {string}   profile.current_role       - Current role name or ID
 * @param {string}   profile.target_role        - Target role name or ID
 * @param {string[]} profile.skills             - User skill names/IDs
 * @param {Object[]} profile.skill_levels       - [{ skill, level }] proficiency data
 * @param {string}   profile.education_level    - e.g. 'bachelors', 'masters'
 * @param {number}   profile.years_experience   - Total years of experience
 * @param {number}   profile.current_salary     - Current salary (same currency as DB)
 *
 * @returns {Promise<{
 *   chi_score: number,
 *   breakdown: Object,
 *   insights: string[],
 *   meta: Object
 * }>}
 */
async function calculateCHI(profile) {
  const {
    current_role,
    target_role,
    skills         = [],
    skill_levels   = [],
    education_level,
    years_experience = 0,
    current_salary   = 0,
  } = profile;

  if (!target_role) {
    throw new Error('target_role is required for CHI v2 calculation');
  }

  const startTime = Date.now();

  // ── Resolve role IDs ────────────────────────────────────────────────────────
  const [targetRoleId, currentRoleId] = await Promise.all([
    resolveRoleId(target_role),
    current_role ? resolveRoleId(current_role) : Promise.resolve(null),
  ]);

  if (!targetRoleId) {
    throw new Error(`Target role not found in graph: "${target_role}"`);
  }

  logger.debug('[CHIv2] Resolved roles', { currentRoleId, targetRoleId });

  // ── Component 1: Skill Match ────────────────────────────────────────────────
  const skillMatchResult = await computeSkillMatch(targetRoleId, skills);

  // ── Component 2: Skill Depth ────────────────────────────────────────────────
  const skillDepthResult = computeSkillDepth(skillMatchResult.matched, skill_levels);

  // ── Components 3 & 4: Career Distance + Experience (single BFS) ────────────
  let distanceResult = { found: false, steps: 5, totalYears: 0, path: [] };

  if (currentRoleId && currentRoleId !== targetRoleId) {
    distanceResult = await bfsCareerPath(currentRoleId, targetRoleId);
  } else if (currentRoleId === targetRoleId) {
    distanceResult = { found: true, steps: 0, totalYears: 0, path: [currentRoleId] };
  }

  const careerDistanceScore = computeCareerDistanceScore(distanceResult.steps);
  const experienceScore     = computeExperienceScore(
    Number(years_experience) || 0,
    distanceResult.totalYears
  );

  // ── Component 5: Education ──────────────────────────────────────────────────
  const educationScore = await computeEducationScore(targetRoleId, education_level);

  // ── Component 6: Market Salary ──────────────────────────────────────────────
  const salaryScore = await computeMarketSalaryScore(targetRoleId, Number(current_salary) || 0);

  // ── Aggregate CHI ───────────────────────────────────────────────────────────
  const breakdown = {
    skill_match:      skillMatchResult.score,
    skill_depth:      skillDepthResult.score,
    career_distance:  careerDistanceScore,
    experience_score: experienceScore,
    education_score:  educationScore,
    salary_score:     salaryScore,
  };

  const chi_score = Math.round(
    breakdown.skill_match      * WEIGHTS.skillMatch     +
    breakdown.skill_depth      * WEIGHTS.skillDepth     +
    breakdown.career_distance  * WEIGHTS.careerDistance +
    breakdown.experience_score * WEIGHTS.experience     +
    breakdown.education_score  * WEIGHTS.education      +
    breakdown.salary_score     * WEIGHTS.marketSalary
  );

  // ── Insights ────────────────────────────────────────────────────────────────
  const insights = generateInsights({
    breakdown,
    missingSkills: skillMatchResult.missing,
    steps:         distanceResult.steps,
    expectedYears: distanceResult.totalYears,
    userYears:     Number(years_experience) || 0,
    educationScore,
    salaryScore,
  });

  const elapsed = Date.now() - startTime;
  logger.info('[CHIv2] Calculation complete', { chi_score, elapsed_ms: elapsed });

  return {
    chi_score,
    breakdown,
    insights,
    meta: {
      engine_version:   'chi_v2',
      target_role_id:   targetRoleId,
      current_role_id:  currentRoleId ?? null,
      career_path_found: distanceResult.found,
      career_path_steps: distanceResult.steps,
      career_path:       distanceResult.path,
      skills_matched:    skillMatchResult.matched.length,
      skills_missing:    skillMatchResult.missing.length,
      calculated_at:     new Date().toISOString(),
    },
  };
}

module.exports = {
  calculateCHI,
  resolveRoleId,
  // Export sub-components for unit testing
  computeSkillMatch,
  computeSkillDepth,
  computeCareerDistanceScore,
  computeExperienceScore,
  computeEducationScore,
  computeMarketSalaryScore,
  bfsCareerPath,
  generateInsights,
  WEIGHTS,
  SKILL_LEVEL_SCORES,
};








