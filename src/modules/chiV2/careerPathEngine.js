'use strict';

const { supabase } = require('../../config/supabase');
const { bfsCareerPath } = require('./chiV2.engine');
const { predictCareerPath } = require('../../engines/career-path.engine');
const logger = require('../../utils/logger');

const DEFAULT_TRANSITION = Object.freeze({
  years_required: 2,
  probability: null,
  transition_type: null
});

// ─────────────────────────────────────────────────────────────────────────────
// Role Metadata
// ─────────────────────────────────────────────────────────────────────────────

async function fetchRoleMeta(roleIds) {
  if (!roleIds?.length) return {};

  const uniqueIds = [...new Set(roleIds)];

  const { data, error } = await supabase
    .from('roles')
    .select('id, role_name, role_family, seniority_level')
    .in('id', uniqueIds);

  if (error) {
    logger.error('[CareerPathEngine] Role meta fetch failed', {
      error: error.message
    });
    return {};
  }

  const map = {};
  for (const row of data || []) {
    map[row.id] = row;
  }

  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bulk Transitions
// ─────────────────────────────────────────────────────────────────────────────

async function fetchTransitionsForPath(pathIds) {
  if (!pathIds?.length || pathIds.length < 2) return [];

  const fromIds = pathIds.slice(0, -1);

  const { data, error } = await supabase
    .from('role_transitions')
    .select(
      'from_role_id, to_role_id, years_required, probability, transition_type'
    )
    .in('from_role_id', fromIds);

  if (error) {
    logger.warn('[CareerPathEngine] Transition fetch degraded', {
      error: error.message
    });

    return pathIds.slice(0, -1).map(() => DEFAULT_TRANSITION);
  }

  const transitionMap = new Map();

  for (const row of data || []) {
    transitionMap.set(`${row.from_role_id}:${row.to_role_id}`, {
      years_required: Number(row.years_required) || 2,
      probability: row.probability ?? null,
      transition_type: row.transition_type ?? null
    });
  }

  return pathIds.slice(0, -1).map((fromId, index) => {
    const toId = pathIds[index + 1];
    return (
      transitionMap.get(`${fromId}:${toId}`) || DEFAULT_TRANSITION
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Bulk Skills
// ─────────────────────────────────────────────────────────────────────────────

async function fetchRoleSkillsBulk(roleIds, limit = 8) {
  if (!roleIds?.length) return {};

  const uniqueIds = [...new Set(roleIds)];

  const { data, error } = await supabase
    .from('role_skills')
    .select(
      'role_id, skill_id, skill_name, importance_weight'
    )
    .in('role_id', uniqueIds);

  if (error) {
    logger.warn('[CareerPathEngine] Skills fetch degraded', {
      error: error.message
    });
    return {};
  }

  const grouped = {};

  for (const row of data || []) {
    if (!grouped[row.role_id]) grouped[row.role_id] = [];
    grouped[row.role_id].push({
      skill_id: row.skill_id,
      skill_name: row.skill_name ?? row.skill_id,
      importance_weight: Number(row.importance_weight) || 1
    });
  }

  for (const roleId of Object.keys(grouped)) {
    grouped[roleId] = grouped[roleId]
      .sort((a, b) => b.importance_weight - a.importance_weight)
      .slice(0, limit);
  }

  return grouped;
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy Compatibility
// ─────────────────────────────────────────────────────────────────────────────

async function fetchRoleSkillNames(roleId, limit = 10) {
  const grouped = await fetchRoleSkillsBulk([roleId], limit);
  return grouped[roleId] || [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Enrich Path
// ─────────────────────────────────────────────────────────────────────────────

async function enrichPath(pathIds) {
  if (!pathIds?.length) return [];

  const [roleMeta, transitions, skillsMap] = await Promise.all([
    fetchRoleMeta(pathIds),
    fetchTransitionsForPath(pathIds),
    fetchRoleSkillsBulk(pathIds, 8)
  ]);

  let cumulativeYears = 0;

  return pathIds.map((roleId, index) => {
    const role = roleMeta[roleId] || {
      id: roleId,
      role_name: roleId
    };

    const transition = transitions[index] || null;

    if (transition) {
      cumulativeYears += transition.years_required || 0;
    }

    return {
      step: index + 1,
      role_id: roleId,
      role_name: role.role_name ?? roleId,
      role_family: role.role_family ?? null,
      seniority_level: role.seniority_level ?? null,
      required_skills: skillsMap[roleId] || [],
      transition_to_next: transition,
      cumulative_years: cumulativeYears,
      is_current_role: index === 0,
      is_target_role: index === pathIds.length - 1
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function recommendCareerPath(currentRoleId, targetRoleId) {
  const start = Date.now();

  if (!currentRoleId) {
    const skills = await fetchRoleSkillNames(targetRoleId);

    return {
      found: false,
      career_path: [],
      next_role_skills: skills,
      message: 'No current role provided'
    };
  }

  if (currentRoleId === targetRoleId) {
    return {
      found: true,
      career_path: [],
      message: 'Already in target role'
    };
  }

  const bfs = await bfsCareerPath(currentRoleId, targetRoleId);

  if (!bfs?.found) {
    return {
      found: false,
      career_path: [],
      message: 'No path found'
    };
  }

  const enriched = await enrichPath(bfs.path);

  const totalYears = enriched.reduce(
    (sum, step) => sum + (step.transition_to_next?.years_required || 0),
    0
  );

  let csvPrediction = null;

  try {
    const roleName = enriched[0]?.role_name;
    if (roleName) {
      csvPrediction = await predictCareerPath({ role: roleName });
    }
  } catch (error) {
    logger.warn('[CareerPathEngine] CSV prediction degraded', {
      error: error.message
    });
  }

  logger.info('[CareerPathEngine] Completed', {
    steps: bfs.steps,
    years: totalYears,
    ms: Date.now() - start
  });

  return {
    found: true,
    career_path: enriched,
    steps: bfs.steps,
    estimated_years: totalYears,
    career_path_prediction: csvPrediction
  };
}

module.exports = {
  recommendCareerPath,
  fetchRoleMeta,
  fetchRoleSkillNames,
  enrichPath
};