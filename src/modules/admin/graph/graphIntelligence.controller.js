'use strict';

/**
 * graphIntelligence.controller.js — Admin Graph Intelligence (Supabase)
 * MIGRATED: Firestore 'roles','skills','role_*' collections → Supabase tables
 * Same API contract — no frontend changes needed.
 */

const { asyncHandler }         = require('../../../utils/helpers');
const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');

function getSupabase() { return require('../../../core/supabaseClient'); }

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchAll(table, select = '*') {
  const { data = [] } = await getSupabase().from(table).select(select) || {};
  return data || [];
}

async function fetchWhere(table, col, val, select = '*') {
  const { data = [] } = await getSupabase().from(table).select(select).eq(col, val) || {};
  return data || [];
}

async function fetchById(table, idCol, id) {
  // HARDENING T2: .single() → .maybeSingle() — record may not exist
  // HARDENING T7: destructure and surface error
  const { data, error } = await getSupabase().from(table).select('*').eq(idCol, id).maybeSingle();
  if (error) throw error;
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. CAREER GRAPH EXPLORER
// ─────────────────────────────────────────────────────────────────────────────

const getCareerGraph = asyncHandler(async (_req, res) => {
  const [roles, transitions] = await Promise.all([
    fetchAll('roles'),
    fetchAll('role_transitions'),
  ]);
  res.json({ success: true, data: {
    roles:       roles.filter(r => r.name || r.role_name),
    transitions,
    node_count:  roles.length,
    edge_count:  transitions.length,
  }});
});

const getRoleDetail = asyncHandler(async (req, res) => {
  const { roleId } = req.params;
  const supabase = getSupabase();

  const role = await fetchById('roles', 'role_id', roleId);
  if (!role) throw new AppError(`Role not found: ${roleId}`, 404, { roleId }, ErrorCodes.NOT_FOUND);

  const [skills, outgoing, incoming, salary, education] = await Promise.all([
    fetchWhere('role_skills',        'role_id',      roleId),
    fetchWhere('role_transitions',   'from_role_id', roleId),
    fetchWhere('role_transitions',   'to_role_id',   roleId),
    fetchWhere('role_salary_market', 'role_id',      roleId),
    fetchWhere('role_education',     'role_id',      roleId),
  ]);

  // Enrich skill IDs with names
  const skillIds = [...new Set(skills.map(s => s.skill_id).filter(Boolean))];
  let skillDetails = skills;
  if (skillIds.length) {
    const { data: skillDocs = [] } = await supabase.from('skills').select('skill_id, name, skill_name').in('skill_id', skillIds);
    const skillMap = Object.fromEntries(skillDocs.map(s => [s.skill_id, s.skill_name || s.name || s.skill_id]));
    skillDetails = skills.map(s => ({ ...s, skill_name: skillMap[s.skill_id] ?? s.skill_id }));
  }

  // Enrich transitions with role names
  const enrichTransitions = async (rows, roleField) => {
    const ids = [...new Set(rows.map(r => r[roleField]).filter(Boolean))];
    const { data: roleDocs = [] } = await supabase.from('roles').select('role_id, name, role_name').in('role_id', ids);
    const roleMap = Object.fromEntries(roleDocs.map(r => [r.role_id, r.role_name || r.name || r.role_id]));
    return rows.map(r => ({ ...r, [`${roleField}_name`]: roleMap[r[roleField]] ?? r[roleField] }));
  };

  const [enrichedOutgoing, enrichedIncoming] = await Promise.all([
    enrichTransitions(outgoing, 'to_role_id'),
    enrichTransitions(incoming, 'from_role_id'),
  ]);

  res.json({ success: true, data: {
    role, skills: skillDetails,
    outgoing_transitions: enrichedOutgoing,
    incoming_transitions: enrichedIncoming,
    salary, education,
  }});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. SKILL GRAPH EXPLORER
// ─────────────────────────────────────────────────────────────────────────────

const getSkillGraph = asyncHandler(async (_req, res) => {
  const [skills, relationships] = await Promise.all([
    fetchAll('skills'),
    fetchAll('skill_relationships'),
  ]);
  res.json({ success: true, data: {
    skills:        skills.filter(s => s.name || s.skill_name),
    relationships,
    node_count:    skills.length,
    edge_count:    relationships.length,
  }});
});

const getSkillDetail = asyncHandler(async (req, res) => {
  const { skillId } = req.params;
  const supabase = getSupabase();

  const skill = await fetchById('skills', 'skill_id', skillId);
  if (!skill) throw new AppError(`Skill not found: ${skillId}`, 404, { skillId }, ErrorCodes.NOT_FOUND);

  const [prereqs, advanced, roleSkills] = await Promise.all([
    supabase.from('skill_relationships').select('*').eq('skill_id', skillId).eq('relationship_type', 'prerequisite').then(r => r.data || []),
    supabase.from('skill_relationships').select('*').eq('related_skill_id', skillId).eq('relationship_type', 'prerequisite').then(r => r.data || []),
    fetchWhere('role_skills', 'skill_id', skillId),
  ]);

  // Enrich with skill/role names
  const allSkillIds = [...new Set([...prereqs.map(r => r.related_skill_id), ...advanced.map(r => r.skill_id)])].filter(Boolean);
  const allRoleIds  = [...new Set(roleSkills.map(r => r.role_id))].filter(Boolean);

  const [{ data: skillDocs = [] }, { data: roleDocs = [] }] = await Promise.all([
    allSkillIds.length ? supabase.from('skills').select('skill_id, skill_name, name').in('skill_id', allSkillIds) : { data: [] },
    allRoleIds.length  ? supabase.from('roles').select('role_id, role_name, name').in('role_id', allRoleIds)   : { data: [] },
  ]);

  const skillMap = Object.fromEntries(skillDocs.map(s => [s.skill_id, s.skill_name || s.name || s.skill_id]));
  const roleMap  = Object.fromEntries(roleDocs.map(r => [r.role_id, r.role_name || r.name || r.role_id]));

  res.json({ success: true, data: {
    skill,
    prerequisites:   prereqs.map(r => ({ ...r, related_skill_id_name: skillMap[r.related_skill_id] ?? r.related_skill_id })),
    advanced_skills: advanced.map(r => ({ ...r, skill_id_name: skillMap[r.skill_id] ?? r.skill_id })),
    roles:           roleSkills.map(r => ({ ...r, role_name: roleMap[r.role_id] ?? r.role_id })),
  }});
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. CAREER PATH SIMULATOR
// ─────────────────────────────────────────────────────────────────────────────

const simulatePath = asyncHandler(async (req, res) => {
  const { current_role_id, target_role_id, max_hops = 6 } = req.body;
  if (!current_role_id || !target_role_id)
    throw new AppError('current_role_id and target_role_id are required', 400, {}, ErrorCodes.VALIDATION_ERROR);
  if (current_role_id === target_role_id)
    throw new AppError('current_role_id and target_role_id must be different', 400, {}, ErrorCodes.VALIDATION_ERROR);

  const supabase = getSupabase();

  // Load all transitions once for BFS (more efficient than N queries)
  const { data: allTransitions = [] } = await supabase.from('role_transitions').select('from_role_id, to_role_id');
  const adj = {};
  for (const { from_role_id, to_role_id } of allTransitions) {
    if (!adj[from_role_id]) adj[from_role_id] = [];
    adj[from_role_id].push(to_role_id);
  }

  // BFS
  const visited = new Set();
  const queue = [[current_role_id]];
  let foundPath = null;

  while (queue.length && !foundPath) {
    const path = queue.shift();
    const current = path[path.length - 1];
    if (visited.has(current) || path.length > max_hops + 1) continue;
    visited.add(current);
    for (const next of (adj[current] || [])) {
      if (next === target_role_id) { foundPath = [...path, next]; break; }
      if (!visited.has(next)) queue.push([...path, next]);
    }
  }

  if (!foundPath) {
    return res.json({ success: true, data: { found: false,
      message: `No path found from "${current_role_id}" to "${target_role_id}" within ${max_hops} hops.`,
      path: [], steps: [] }});
  }

  // Enrich path nodes
  const { data: roleDocs = [] } = await supabase.from('roles').select('*').in('role_id', foundPath);
  const roleMap = Object.fromEntries(roleDocs.map(r => [r.role_id, r]));

  const steps = await Promise.all(foundPath.map(async (roleId, i) => {
    const roleData = roleMap[roleId] || { role_id: roleId };
    const skills = await fetchWhere('role_skills', 'role_id', roleId, 'skill_id').then(rows => rows.slice(0, 10));
    let transition = null;
    if (i < foundPath.length - 1) {
      const nextId = foundPath[i + 1];
      transition = allTransitions.find(t => t.from_role_id === roleId && t.to_role_id === nextId) || null;
    }
    return { step: i + 1, role_id: roleId,
      role_name: roleData.role_name || roleData.name || roleId,
      role_family: roleData.role_family || null,
      seniority: roleData.seniority_level || null,
      skills, transition_to_next: transition };
  }));

  res.json({ success: true, data: {
    found: true, hops: foundPath.length - 1, path: foundPath, steps,
    current_role: steps[0]?.role_name,
    target_role:  steps[steps.length - 1]?.role_name,
  }});
});

const searchRoles = asyncHandler(async (req, res) => {
  const { q = '', limit = 20 } = req.query;
  const supabase = getSupabase();
  const limitInt = Math.min(parseInt(limit, 10) || 20, 50);
  const term = String(q).trim();

  let query = supabase.from('roles').select('role_id, role_name, name, role_family, seniority_level').limit(limitInt);
  if (term) query = query.or(`role_name.ilike.%${term}%,name.ilike.%${term}%`);
  const { data: roles = [] } = await query.order('role_name');

  res.json({ success: true, data: {
    roles: roles.map(r => ({ id: r.role_id, role_id: r.role_id,
      role_name: r.role_name || r.name || r.role_id,
      role_family: r.role_family || null, seniority: r.seniority_level || null })),
    count: roles.length,
  }});
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. ROLE IMPACT ANALYZER
// ─────────────────────────────────────────────────────────────────────────────

const getRoleImpact = asyncHandler(async (req, res) => {
  const { roleId } = req.params;

  const role = await fetchById('roles', 'role_id', roleId);
  if (!role) throw new AppError(`Role not found: ${roleId}`, 404, { roleId }, ErrorCodes.NOT_FOUND);

  const [outgoing, incoming, skills, salary, education] = await Promise.all([
    fetchWhere('role_transitions',   'from_role_id', roleId),
    fetchWhere('role_transitions',   'to_role_id',   roleId),
    fetchWhere('role_skills',        'role_id',      roleId),
    fetchWhere('role_salary_market', 'role_id',      roleId),
    fetchWhere('role_education',     'role_id',      roleId),
  ]);

  const salaryStats = salary.length > 0 ? {
    count:    salary.length,
    countries: [...new Set(salary.map(s => s.country).filter(Boolean))],
    median_range: {
      min: Math.min(...salary.map(s => s.median_salary || 0).filter(v => v > 0)),
      max: Math.max(...salary.map(s => s.median_salary || 0).filter(v => v > 0)),
    },
  } : null;

  res.json({ success: true, data: {
    role,
    impact: {
      outgoing_transitions: outgoing.length, incoming_transitions: incoming.length,
      total_transitions:    outgoing.length + incoming.length,
      skill_mappings: skills.length, salary_benchmarks: salary.length,
      education_mappings: education.length,
    },
    salary_stats:         salaryStats,
    education_summary:    education.map(e => ({ education_level: e.education_level, match_score: e.match_score })),
    outgoing_transitions: outgoing,
    incoming_transitions: incoming,
    skill_mappings:       skills,
  }});
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. MARKET INTELLIGENCE
// ─────────────────────────────────────────────────────────────────────────────

const getMarketIntelligence = asyncHandler(async (req, res) => {
  const { getMarketIntelligenceSummary } = require('../../chiV2/careerOpportunityEngine');
  const country = req.query.country ?? null;
  const data = await getMarketIntelligenceSummary(country);
  res.json({ success: true, data });
});

module.exports = { getCareerGraph, getRoleDetail, getSkillGraph, getSkillDetail,
  simulatePath, searchRoles, getRoleImpact, getMarketIntelligence };