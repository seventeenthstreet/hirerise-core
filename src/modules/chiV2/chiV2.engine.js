'use strict';

const { supabase } = require('../../config/supabase');
const logger = require('../../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const WEIGHTS = Object.freeze({
  skillMatch: 0.3,
  skillDepth: 0.15,
  careerDistance: 0.2,
  experience: 0.15,
  education: 0.1,
  marketSalary: 0.1
});

const SKILL_LEVEL_SCORES = Object.freeze({
  beginner: 40,
  intermediate: 70,
  advanced: 90,
  expert: 100
});

const EDUCATION_RANK = Object.freeze({
  none: 0,
  high_school: 1,
  diploma: 2,
  bachelors: 3,
  masters: 4,
  phd: 5
});

const CAREER_DISTANCE_PENALTY_PER_STEP = 15;
const SALARY_SCORE_MIN = 30;
const SALARY_SCORE_MAX = 100;
const BFS_MAX_DEPTH = 10;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// Role Resolver (Optimized)
// ─────────────────────────────────────────────────────────────────────────────

async function resolveRoleId(identifier) {
  if (!identifier) return null;

  const normalized = String(identifier).trim();

  const { data, error } = await supabase
    .from('roles')
    .select('id, role_id, role_name')
    .or(
      `id.eq.${normalized},role_id.eq.${normalized},role_name.eq.${normalized}`
    )
    .limit(1)
    .maybeSingle();

  if (error) {
    logger.warn('[CHIv2] Role resolution degraded', {
      identifier,
      error: error.message
    });
    return null;
  }

  return data?.id ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill Match
// ─────────────────────────────────────────────────────────────────────────────

async function computeSkillMatch(roleId, userSkills) {
  const { data, error } = await supabase
    .from('role_skills')
    .select('skill_id, skill_name, importance_weight')
    .eq('role_id', roleId);

  if (error || !data?.length) {
    return {
      score: 50,
      matched: [],
      missing: [],
      totalWeight: 0
    };
  }

  const userSet = new Set(
    (userSkills || []).map(skill => normalizeText(skill))
  );

  let matchedWeight = 0;
  let totalWeight = 0;

  const matched = [];
  const missing = [];

  for (const row of data) {
    const weight = Number(row.importance_weight) || 1;
    totalWeight += weight;

    const skillName = row.skill_name || row.skill_id || '';
    const normalizedSkill = normalizeText(skillName);

    if (userSet.has(normalizedSkill)) {
      matchedWeight += weight;
      matched.push(skillName);
    } else {
      missing.push(skillName);
    }
  }

  return {
    score: totalWeight
      ? Math.round((matchedWeight / totalWeight) * 100)
      : 50,
    matched,
    missing,
    totalWeight
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill Depth
// ─────────────────────────────────────────────────────────────────────────────

function computeSkillDepth(matchedSkills, skillLevels) {
  if (!matchedSkills?.length) return { score: 50 };

  const levelMap = {};

  for (const row of skillLevels || []) {
    const key = normalizeText(row.skill);
    if (key) levelMap[key] = row.level;
  }

  let total = 0;

  for (const skill of matchedSkills) {
    const level = levelMap[normalizeText(skill)] || 'intermediate';
    total += SKILL_LEVEL_SCORES[level] || 70;
  }

  return {
    score: Math.round(total / matchedSkills.length),
    levelMap
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// BFS Career Path (Level Batch Optimized)
// ─────────────────────────────────────────────────────────────────────────────

async function bfsCareerPath(current, target) {
  if (current === target) {
    return {
      found: true,
      steps: 0,
      totalYears: 0,
      path: [current]
    };
  }

  const visited = new Set([current]);
  let frontier = [{ id: current, path: [current], years: 0 }];

  for (let depth = 0; depth < BFS_MAX_DEPTH; depth++) {
    const currentIds = frontier.map(node => node.id);
    if (!currentIds.length) break;

    const { data, error } = await supabase
      .from('role_transitions')
      .select('from_role_id,to_role_id,years_required')
      .in('from_role_id', currentIds);

    if (error) {
      logger.warn('[CHIv2] BFS degraded', {
        error: error.message
      });
      break;
    }

    const grouped = new Map();

    for (const row of data || []) {
      if (!grouped.has(row.from_role_id)) {
        grouped.set(row.from_role_id, []);
      }
      grouped.get(row.from_role_id).push(row);
    }

    const nextFrontier = [];

    for (const node of frontier) {
      const edges = grouped.get(node.id) || [];

      for (const edge of edges) {
        const next = edge.to_role_id;
        if (!next || visited.has(next)) continue;

        const years =
          node.years + (Number(edge.years_required) || 0);

        const newPath = [...node.path, next];

        if (next === target) {
          return {
            found: true,
            steps: newPath.length - 1,
            totalYears: years,
            path: newPath
          };
        }

        visited.add(next);

        nextFrontier.push({
          id: next,
          path: newPath,
          years
        });
      }
    }

    frontier = nextFrontier;
  }

  return {
    found: false,
    steps: BFS_MAX_DEPTH,
    totalYears: 0,
    path: []
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Education
// ─────────────────────────────────────────────────────────────────────────────

async function computeEducationScore(roleId, userLevel) {
  const { data } = await supabase
    .from('role_education')
    .select('education_level, match_score')
    .eq('role_id', roleId);

  if (!data?.length) return 70;

  const userRank = EDUCATION_RANK[userLevel] ?? 2;

  let best = 0;

  for (const row of data) {
    const reqRank = EDUCATION_RANK[row.education_level] ?? 2;
    const score = Number(row.match_score) || 70;

    best = Math.max(
      best,
      userRank >= reqRank ? score : score * 0.6
    );
  }

  return Math.min(best, 100);
}

// ─────────────────────────────────────────────────────────────────────────────
// Salary
// ─────────────────────────────────────────────────────────────────────────────

async function computeMarketSalaryScore(roleId, userSalary) {
  if (!userSalary) return 50;

  const { data } = await supabase
    .from('role_salary_market')
    .select('median_salary')
    .eq('role_id', roleId);

  if (!data?.length) return 50;

  const valid = data.filter(row => row.median_salary > 0);
  if (!valid.length) return 50;

  const avg =
    valid.reduce((sum, row) => sum + row.median_salary, 0) /
    valid.length;

  const raw = (userSalary / avg) * 100;

  return Math.min(
    Math.max(raw, SALARY_SCORE_MIN),
    SALARY_SCORE_MAX
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function calculateCHI(profile) {
  const start = Date.now();

  const [targetRoleId, currentRoleId] = await Promise.all([
    resolveRoleId(profile.target_role),
    profile.current_role
      ? resolveRoleId(profile.current_role)
      : Promise.resolve(null)
  ]);

  if (!targetRoleId) {
    throw new Error('Target role not found');
  }

  const skillMatchPromise = computeSkillMatch(
    targetRoleId,
    profile.skills
  );

  const distancePromise = currentRoleId
    ? bfsCareerPath(currentRoleId, targetRoleId)
    : Promise.resolve({
        steps: 5,
        totalYears: 0,
        found: false
      });

  const educationPromise = computeEducationScore(
    targetRoleId,
    profile.education_level
  );

  const salaryPromise = computeMarketSalaryScore(
    targetRoleId,
    profile.current_salary
  );

  const [skillMatch, distance, educationScore, salaryScore] =
    await Promise.all([
      skillMatchPromise,
      distancePromise,
      educationPromise,
      salaryPromise
    ]);

  const skillDepth = computeSkillDepth(
    skillMatch.matched,
    profile.skill_levels
  );

  const breakdown = {
    skill_match: skillMatch.score,
    skill_depth: skillDepth.score,
    career_distance: Math.max(
      100 - distance.steps * CAREER_DISTANCE_PENALTY_PER_STEP,
      0
    ),
    experience_score: Math.min(
      ((profile.years_experience || 0) /
        (distance.totalYears || 1)) *
        100,
      100
    ),
    education_score: educationScore,
    salary_score: salaryScore
  };

  const chi_score = Math.round(
    breakdown.skill_match * WEIGHTS.skillMatch +
      breakdown.skill_depth * WEIGHTS.skillDepth +
      breakdown.career_distance * WEIGHTS.careerDistance +
      breakdown.experience_score * WEIGHTS.experience +
      breakdown.education_score * WEIGHTS.education +
      breakdown.salary_score * WEIGHTS.marketSalary
  );

  logger.info('[CHIv2] Complete', {
    chi_score,
    ms: Date.now() - start
  });

  // Persist score to chi_scores so chi_weekly_rollups_mv and
  // chi_cohort_benchmark_mv materialised views have data to aggregate.
  // Non-blocking — a save failure must never break the API response.
  if (profile._userId) {
    setImmediate(async () => {
      try {
        const { error: saveError } = await supabase
          .from('chi_scores')
          .upsert(
            {
              id: `${profile._userId}:${targetRoleId}`,
              user_id: profile._userId,
              role_id: targetRoleId,
              skill_match: breakdown.skill_match,
              experience_fit: breakdown.experience_score,
              market_demand: breakdown.salary_score,
              learning_progress: breakdown.skill_depth,
              chi_score,
              last_updated: new Date().toISOString(),
            },
            { onConflict: 'id' }
          );

        if (saveError) {
          logger.warn('[CHIv2] Score persist failed', {
            userId: profile._userId,
            error: saveError.message,
          });
        } else {
          logger.debug('[CHIv2] Score persisted', {
            userId: profile._userId,
            chi_score,
          });
        }
      } catch (err) {
        logger.warn('[CHIv2] Score persist exception', {
          userId: profile._userId,
          error: err.message,
        });
      }
    });
  }

  return {
    chi_score,
    breakdown,
    insights: [],
    meta: {
      target_role_id: targetRoleId,
      current_role_id: currentRoleId
    }
  };
}

module.exports = {
  calculateCHI,
  resolveRoleId,
  computeSkillMatch,
  computeSkillDepth,
  bfsCareerPath,
  computeEducationScore,
  computeMarketSalaryScore
};