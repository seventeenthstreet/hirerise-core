'use strict';

/**
 * core-work/src/modules/admin/graph/graphIntelligence.controller.js
 *
 * Graph Intelligence Controller
 * Fully Firebase-free + Supabase production optimized
 */

const { asyncHandler } = require('../../../utils/helpers');
const {
  AppError,
  ErrorCodes,
} = require('../../../middleware/errorHandler');
const { supabase } = require('../../../config/supabase');

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

async function mapRolesById(roleIds = []) {
  const ids = [...new Set(ensureArray(roleIds).filter(Boolean))];
  if (!ids.length) return {};

  const { data, error } = await supabase
    .from('roles')
    .select('id, role_name')
    .in('id', ids);

  if (error) {
    throw new AppError(
      'Failed to load role references',
      500,
      { cause: error.message },
      ErrorCodes.INTERNAL_ERROR
    );
  }

  return Object.fromEntries(
    ensureArray(data).map((row) => [row.id, row.role_name])
  );
}

async function mapSkillsById(skillIds = []) {
  const ids = [...new Set(ensureArray(skillIds).filter(Boolean))];
  if (!ids.length) return {};

  const { data, error } = await supabase
    .from('skills')
    .select('skill_id, skill_name')
    .in('skill_id', ids);

  if (error) {
    throw new AppError(
      'Failed to load skill references',
      500,
      { cause: error.message },
      ErrorCodes.INTERNAL_ERROR
    );
  }

  return Object.fromEntries(
    ensureArray(data).map((row) => [row.skill_id, row.skill_name])
  );
}

function enrichRows(rows, field, lookupMap) {
  return ensureArray(rows).map((row) => ({
    ...row,
    [`${field}_name`]: lookupMap[row[field]] || row[field],
  }));
}

// ─────────────────────────────────────────────────────────────
// 1) CAREER GRAPH
// ─────────────────────────────────────────────────────────────

const getCareerGraph = asyncHandler(async (_req, res) => {
  const [rolesResult, transitionsResult] = await Promise.all([
    supabase
      .from('roles')
      .select('id, role_name')
      .order('role_name'),
    supabase
      .from('role_transitions')
      .select('from_role_id, to_role_id'),
  ]);

  if (rolesResult.error || transitionsResult.error) {
    throw new AppError(
      'Failed to fetch career graph',
      500,
      {
        rolesError: rolesResult.error?.message,
        transitionsError: transitionsResult.error?.message,
      },
      ErrorCodes.INTERNAL_ERROR
    );
  }

  const roles = ensureArray(rolesResult.data);
  const transitions = ensureArray(transitionsResult.data);

  return res.json({
    success: true,
    data: {
      roles,
      transitions,
      node_count: roles.length,
      edge_count: transitions.length,
    },
  });
});

// ─────────────────────────────────────────────────────────────
// 2) ROLE DETAIL
// ─────────────────────────────────────────────────────────────

const getRoleDetail = asyncHandler(async (req, res) => {
  const { roleId } = req.params;

  const { data: role, error: roleError } = await supabase
    .from('roles')
    .select('*')
    .eq('id', roleId)
    .maybeSingle();

  if (roleError) {
    throw new AppError(roleError.message, 500);
  }

  if (!role) {
    throw new AppError('Role not found', 404);
  }

  const [
    skillsResult,
    outgoingResult,
    incomingResult,
    salaryResult,
    educationResult,
  ] = await Promise.all([
    supabase.from('role_skills').select('*').eq('role_id', roleId),
    supabase
      .from('role_transitions')
      .select('*')
      .eq('from_role_id', roleId),
    supabase
      .from('role_transitions')
      .select('*')
      .eq('to_role_id', roleId),
    supabase
      .from('role_salary_market')
      .select('*')
      .eq('role_id', roleId),
    supabase
      .from('role_education')
      .select('*')
      .eq('role_id', roleId),
  ]);

  const roleSkills = ensureArray(skillsResult.data);

  const skillMap = await mapSkillsById(
    roleSkills.map((row) => row.skill_id)
  );

  const outgoing = ensureArray(outgoingResult.data);
  const incoming = ensureArray(incomingResult.data);

  const transitionRoleMap = await mapRolesById([
    ...outgoing.map((row) => row.to_role_id),
    ...incoming.map((row) => row.from_role_id),
  ]);

  return res.json({
    success: true,
    data: {
      role,
      skills: roleSkills.map((row) => ({
        ...row,
        skill_name:
          skillMap[row.skill_id] || row.skill_id,
      })),
      outgoing_transitions: enrichRows(
        outgoing,
        'to_role_id',
        transitionRoleMap
      ),
      incoming_transitions: enrichRows(
        incoming,
        'from_role_id',
        transitionRoleMap
      ),
      salary: ensureArray(salaryResult.data),
      education: ensureArray(educationResult.data),
    },
  });
});

// ─────────────────────────────────────────────────────────────
// 3) SKILL GRAPH
// ─────────────────────────────────────────────────────────────

const getSkillGraph = asyncHandler(async (_req, res) => {
  const [skillsResult, relsResult] = await Promise.all([
    supabase
      .from('skills')
      .select('skill_id, skill_name')
      .order('skill_name'),
    supabase
      .from('skill_relationships')
      .select('*'),
  ]);

  if (skillsResult.error || relsResult.error) {
    throw new AppError(
      'Failed to fetch skill graph',
      500,
      {},
      ErrorCodes.INTERNAL_ERROR
    );
  }

  return res.json({
    success: true,
    data: {
      skills: ensureArray(skillsResult.data),
      relationships: ensureArray(relsResult.data),
    },
  });
});

// ─────────────────────────────────────────────────────────────
// 4) SKILL DETAIL
// ─────────────────────────────────────────────────────────────

const getSkillDetail = asyncHandler(async (req, res) => {
  const { skillId } = req.params;

  // FIXED: hidden schema mismatch bug
  const { data: skill, error } = await supabase
    .from('skills')
    .select('*')
    .eq('skill_id', skillId)
    .maybeSingle();

  if (error) {
    throw new AppError(error.message, 500);
  }

  if (!skill) {
    throw new AppError('Skill not found', 404);
  }

  const [rels1, rels2, rolesResult] = await Promise.all([
    supabase
      .from('skill_relationships')
      .select('*')
      .eq('skill_id', skillId),
    supabase
      .from('skill_relationships')
      .select('*')
      .eq('related_skill_id', skillId),
    supabase
      .from('role_skills')
      .select('*')
      .eq('skill_id', skillId),
  ]);

  const rolesRaw = ensureArray(rolesResult.data);

  const roleMap = await mapRolesById(
    rolesRaw.map((row) => row.role_id)
  );

  return res.json({
    success: true,
    data: {
      skill,
      prerequisites: ensureArray(rels1.data),
      advanced_skills: ensureArray(rels2.data),
      roles: rolesRaw.map((row) => ({
        ...row,
        role_name:
          roleMap[row.role_id] || row.role_id,
      })),
    },
  });
});

// ─────────────────────────────────────────────────────────────
// 5) SIMULATE PATH (BFS)
// ─────────────────────────────────────────────────────────────

const simulatePath = asyncHandler(async (req, res) => {
  const { current_role_id, target_role_id } = req.body || {};

  if (!current_role_id || !target_role_id) {
    throw new AppError('Missing role ids', 400);
  }

  const { data: transitions, error } = await supabase
    .from('role_transitions')
    .select('from_role_id, to_role_id');

  if (error) {
    throw new AppError(error.message, 500);
  }

  const graph = Object.create(null);

  for (const row of ensureArray(transitions)) {
    if (!graph[row.from_role_id]) {
      graph[row.from_role_id] = [];
    }

    graph[row.from_role_id].push(row.to_role_id);
  }

  const visited = new Set();
  const queue = [[current_role_id]];
  let pointer = 0;

  while (pointer < queue.length) {
    const path = queue[pointer++];
    const current = path[path.length - 1];

    if (current === target_role_id) {
      return res.json({
        success: true,
        data: {
          found: true,
          path,
        },
      });
    }

    if (visited.has(current)) {
      continue;
    }

    visited.add(current);

    for (const next of graph[current] || []) {
      if (!visited.has(next)) {
        queue.push([...path, next]);
      }
    }
  }

  return res.json({
    success: true,
    data: {
      found: false,
      path: [],
    },
  });
});

// ─────────────────────────────────────────────────────────────

module.exports = {
  getCareerGraph,
  getRoleDetail,
  getSkillGraph,
  getSkillDetail,
  simulatePath,
};