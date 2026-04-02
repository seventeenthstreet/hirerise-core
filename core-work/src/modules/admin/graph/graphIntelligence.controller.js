'use strict';

/**
 * graphIntelligence.controller.js (Optimized)
 * Firebase-free + Production-ready
 */

const { asyncHandler } = require('../../../utils/helpers');
const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');
const { supabase } = require('../../../config/supabase');

// ─────────────────────────────────────────────────────────────
// HELPERS (Batch Enrichment — NO N+1)
// ─────────────────────────────────────────────────────────────

async function mapRolesById(roleIds) {
  if (!roleIds.length) return {};

  const { data, error } = await supabase
    .from('roles')
    .select('id, role_name')
    .in('id', roleIds);

  if (error) return {};

  const map = {};
  for (const r of data || []) map[r.id] = r.role_name;
  return map;
}

async function mapSkillsById(skillIds) {
  if (!skillIds.length) return {};

  const { data, error } = await supabase
    .from('skills')
    .select('skill_id, skill_name')
    .in('skill_id', skillIds);

  if (error) return {};

  const map = {};
  for (const s of data || []) map[s.skill_id] = s.skill_name;
  return map;
}

// ─────────────────────────────────────────────────────────────
// 1. CAREER GRAPH
// ─────────────────────────────────────────────────────────────

const getCareerGraph = asyncHandler(async (_req, res) => {
  const [rolesResult, transitionsResult] = await Promise.all([
    supabase.from('roles').select('*').order('role_name'),
    supabase.from('role_transitions').select('*'),
  ]);

  if (rolesResult.error || transitionsResult.error) {
    throw new AppError('Failed to fetch graph', 500, {}, ErrorCodes.INTERNAL_ERROR);
  }

  const roles = rolesResult.data || [];
  const transitions = transitionsResult.data || [];

  res.json({
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
// ROLE DETAIL
// ─────────────────────────────────────────────────────────────

const getRoleDetail = asyncHandler(async (req, res) => {
  const { roleId } = req.params;

  const { data: roleRows, error } = await supabase
    .from('roles')
    .select('*')
    .eq('id', roleId)
    .limit(1);

  if (error) throw new AppError(error.message, 500);
  if (!roleRows?.length) throw new AppError('Role not found', 404);

  const role = roleRows[0];

  const [
    skillsResult,
    outgoingResult,
    incomingResult,
    salaryResult,
    educationResult,
  ] = await Promise.all([
    supabase.from('role_skills').select('*').eq('role_id', roleId),
    supabase.from('role_transitions').select('*').eq('from_role_id', roleId),
    supabase.from('role_transitions').select('*').eq('to_role_id', roleId),
    supabase.from('role_salary_market').select('*').eq('role_id', roleId),
    supabase.from('role_education').select('*').eq('role_id', roleId),
  ]);

  const roleSkills = skillsResult.data || [];

  // 🔥 Batch skill lookup
  const skillIds = [...new Set(roleSkills.map(r => r.skill_id).filter(Boolean))];
  const skillMap = await mapSkillsById(skillIds);

  const skillDetails = roleSkills.map(s => ({
    ...s,
    skill_name: skillMap[s.skill_id] || s.skill_id,
  }));

  // 🔥 Batch role lookup for transitions
  const transitionIds = [
    ...new Set([
      ...(outgoingResult.data || []).map(t => t.to_role_id),
      ...(incomingResult.data || []).map(t => t.from_role_id),
    ]),
  ];

  const roleMap = await mapRolesById(transitionIds);

  const enrich = (rows, field) =>
    (rows || []).map(r => ({
      ...r,
      [`${field}_name`]: roleMap[r[field]] || r[field],
    }));

  res.json({
    success: true,
    data: {
      role,
      skills: skillDetails,
      outgoing_transitions: enrich(outgoingResult.data, 'to_role_id'),
      incoming_transitions: enrich(incomingResult.data, 'from_role_id'),
      salary: salaryResult.data || [],
      education: educationResult.data || [],
    },
  });
});

// ─────────────────────────────────────────────────────────────
// SKILL GRAPH
// ─────────────────────────────────────────────────────────────

const getSkillGraph = asyncHandler(async (_req, res) => {
  const [skillsResult, relsResult] = await Promise.all([
    supabase.from('skills').select('*').order('skill_name'),
    supabase.from('skill_relationships').select('*'),
  ]);

  if (skillsResult.error || relsResult.error) {
    throw new AppError('Failed to fetch skill graph', 500);
  }

  res.json({
    success: true,
    data: {
      skills: skillsResult.data || [],
      relationships: relsResult.data || [],
    },
  });
});

// ─────────────────────────────────────────────────────────────
// SKILL DETAIL
// ─────────────────────────────────────────────────────────────

const getSkillDetail = asyncHandler(async (req, res) => {
  const { skillId } = req.params;

  const { data: skillRows } = await supabase
    .from('skills')
    .select('*')
    .eq('id', skillId)
    .limit(1);

  if (!skillRows?.length) throw new AppError('Skill not found', 404);

  const skill = skillRows[0];

  const [rels1, rels2, rolesResult] = await Promise.all([
    supabase.from('skill_relationships').select('*').eq('skill_id', skillId),
    supabase.from('skill_relationships').select('*').eq('related_skill_id', skillId),
    supabase.from('role_skills').select('*').eq('skill_id', skillId),
  ]);

  const roleIds = [...new Set((rolesResult.data || []).map(r => r.role_id))];
  const roleMap = await mapRolesById(roleIds);

  const roles = (rolesResult.data || []).map(r => ({
    ...r,
    role_name: roleMap[r.role_id] || r.role_id,
  }));

  res.json({
    success: true,
    data: {
      skill,
      prerequisites: rels1.data || [],
      advanced_skills: rels2.data || [],
      roles,
    },
  });
});

// ─────────────────────────────────────────────────────────────
// SIMULATE PATH (OPTIMIZED BFS)
// ─────────────────────────────────────────────────────────────

const simulatePath = asyncHandler(async (req, res) => {
  const { current_role_id, target_role_id } = req.body;

  if (!current_role_id || !target_role_id) {
    throw new AppError('Missing role ids', 400);
  }

  // 🔥 Load all transitions ONCE
  const { data: transitions } = await supabase
    .from('role_transitions')
    .select('from_role_id, to_role_id');

  const graph = {};
  for (const t of transitions || []) {
    if (!graph[t.from_role_id]) graph[t.from_role_id] = [];
    graph[t.from_role_id].push(t.to_role_id);
  }

  const visited = new Set();
  const queue = [[current_role_id]];

  while (queue.length) {
    const path = queue.shift();
    const node = path[path.length - 1];

    if (node === target_role_id) {
      return res.json({
        success: true,
        data: { found: true, path },
      });
    }

    if (visited.has(node)) continue;
    visited.add(node);

    for (const next of graph[node] || []) {
      queue.push([...path, next]);
    }
  }

  res.json({
    success: true,
    data: { found: false, path: [] },
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