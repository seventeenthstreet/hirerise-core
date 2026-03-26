'use strict';

/**
 * graphIntelligence.controller.js
 *
 * Admin-only Graph Intelligence endpoints.
 * Powers the admin Career Graph Explorer, Skill Graph Explorer,
 * Career Path Simulator, and Role Impact Analyzer.
 *
 * MIGRATED: Firestore → Supabase
 * All db.collection(...).get() / .where() / .doc() calls replaced with
 * supabase.from(...).select() / .eq() / .ilike() equivalents.
 *
 * SECURITY: Requires authenticate + requireAdmin middleware (set in routes).
 */

const { asyncHandler }         = require('../../../utils/helpers');
const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');
const careerGraphService        = require('../../careerGraph/careerGraph.service');
const skillGraphService         = require('../../skillGraph/skillGraph.service');
const { createClient }          = require('@supabase/supabase-js');

// ── Supabase client (service-role — admin only, server-side) ──────────────────

let _supabase = null;

function getDb() {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.\n' +
      'These are required by graphIntelligence.controller.js'
    );
  }
  _supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _supabase;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. CAREER GRAPH EXPLORER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/graph-intelligence/career-graph
 */
const getCareerGraph = asyncHandler(async (_req, res) => {
  const supabase = getDb();

  const [rolesResult, transitionsResult] = await Promise.all([
    supabase.from('roles').select('*').order('role_name'),
    supabase.from('role_transitions').select('*'),
  ]);

  if (rolesResult.error) {
    throw new AppError(`Failed to fetch roles: ${rolesResult.error.message}`, 500, {}, ErrorCodes.INTERNAL_ERROR);
  }
  if (transitionsResult.error) {
    throw new AppError(`Failed to fetch transitions: ${transitionsResult.error.message}`, 500, {}, ErrorCodes.INTERNAL_ERROR);
  }

  const roles       = rolesResult.data       ?? [];
  const transitions = transitionsResult.data ?? [];

  res.json({
    success: true,
    data: { roles, transitions, node_count: roles.length, edge_count: transitions.length },
  });
});

/**
 * GET /api/v1/admin/graph-intelligence/career-graph/roles/:roleId
 */
const getRoleDetail = asyncHandler(async (req, res) => {
  const { roleId } = req.params;
  const supabase   = getDb();

  const { data: roleRows, error: roleError } = await supabase
    .from('roles').select('*').eq('id', roleId).limit(1);

  if (roleError) throw new AppError(`DB error: ${roleError.message}`, 500, {}, ErrorCodes.INTERNAL_ERROR);
  if (!roleRows || roleRows.length === 0) {
    throw new AppError(`Role not found: ${roleId}`, 404, { roleId }, ErrorCodes.NOT_FOUND);
  }
  const role = roleRows[0];

  const [skillsResult, outgoingResult, incomingResult, salaryResult, educationResult] = await Promise.all([
    supabase.from('role_skills').select('*').eq('role_id', roleId),
    supabase.from('role_transitions').select('*').eq('from_role_id', roleId),
    supabase.from('role_transitions').select('*').eq('to_role_id', roleId),
    supabase.from('role_salary_market').select('*').eq('role_id', roleId),
    supabase.from('role_education').select('*').eq('role_id', roleId),
  ]);

  for (const [label, result] of [
    ['role_skills', skillsResult], ['outgoing transitions', outgoingResult],
    ['incoming transitions', incomingResult], ['salary', salaryResult], ['education', educationResult],
  ]) {
    if (result.error) throw new AppError(`DB error fetching ${label}: ${result.error.message}`, 500, {}, ErrorCodes.INTERNAL_ERROR);
  }

  const roleSkills = skillsResult.data ?? [];
  const skillIds   = roleSkills.map(r => r.skill_id).filter(Boolean);
  let skillDetails = [];

  if (skillIds.length > 0) {
    const CHUNK = 100;
    const chunks = [];
    for (let i = 0; i < skillIds.length; i += CHUNK) chunks.push(skillIds.slice(i, i + CHUNK));

    const skillResults = await Promise.all(
      chunks.map(chunk => supabase.from('skills').select('*').in('skill_id', chunk))
    );
    const skillMap = {};
    for (const r of skillResults) {
      if (r.error) continue;
      for (const row of r.data ?? []) skillMap[row.skill_id] = row;
    }
    skillDetails = roleSkills.map(sd => ({
      ...sd,
      skill_name: skillMap[sd.skill_id]?.skill_name ?? sd.skill_id,
    }));
  }

  const enrichTransitions = async (rows, roleField) => {
    const enriched = [];
    for (const row of rows) {
      const otherId = row[roleField];
      let otherName = otherId;
      try {
        const { data } = await supabase.from('roles').select('role_name').eq('id', otherId).limit(1);
        if (data && data.length > 0) otherName = data[0].role_name ?? otherId;
      } catch (_) {}
      enriched.push({ ...row, [`${roleField}_name`]: otherName });
    }
    return enriched;
  };

  const [outgoing, incoming] = await Promise.all([
    enrichTransitions(outgoingResult.data ?? [], 'to_role_id'),
    enrichTransitions(incomingResult.data ?? [], 'from_role_id'),
  ]);

  res.json({
    success: true,
    data: {
      role, skills: skillDetails,
      outgoing_transitions: outgoing,
      incoming_transitions: incoming,
      salary:    salaryResult.data    ?? [],
      education: educationResult.data ?? [],
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. SKILL GRAPH EXPLORER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/graph-intelligence/skill-graph
 */
const getSkillGraph = asyncHandler(async (_req, res) => {
  const supabase = getDb();

  const [skillsResult, relsResult] = await Promise.all([
    supabase.from('skills').select('*').order('skill_name'),
    supabase.from('skill_relationships').select('*'),
  ]);

  if (skillsResult.error) {
    throw new AppError(`Failed to fetch skills: ${skillsResult.error.message}`, 500, {}, ErrorCodes.INTERNAL_ERROR);
  }
  if (relsResult.error) {
    throw new AppError(`Failed to fetch skill relationships: ${relsResult.error.message}`, 500, {}, ErrorCodes.INTERNAL_ERROR);
  }

  const skills        = skillsResult.data ?? [];
  const relationships = relsResult.data   ?? [];

  res.json({
    success: true,
    data: { skills, relationships, node_count: skills.length, edge_count: relationships.length },
  });
});

/**
 * GET /api/v1/admin/graph-intelligence/skill-graph/skills/:skillId
 */
const getSkillDetail = asyncHandler(async (req, res) => {
  const { skillId } = req.params;
  const supabase    = getDb();

  const { data: skillRows, error: skillError } = await supabase
    .from('skills').select('*').eq('id', skillId).limit(1);

  if (skillError) throw new AppError(`DB error: ${skillError.message}`, 500, {}, ErrorCodes.INTERNAL_ERROR);
  if (!skillRows || skillRows.length === 0) {
    throw new AppError(`Skill not found: ${skillId}`, 404, { skillId }, ErrorCodes.NOT_FOUND);
  }
  const skill = skillRows[0];

  const [prereqResult, advancedResult, rolesResult] = await Promise.all([
    supabase.from('skill_relationships').select('*').eq('skill_id', skillId).eq('relationship_type', 'prerequisite'),
    supabase.from('skill_relationships').select('*').eq('related_skill_id', skillId).eq('relationship_type', 'prerequisite'),
    supabase.from('role_skills').select('*').eq('skill_id', skillId),
  ]);

  for (const [label, result] of [
    ['prerequisites', prereqResult], ['advanced skills', advancedResult], ['roles', rolesResult],
  ]) {
    if (result.error) throw new AppError(`DB error fetching ${label}: ${result.error.message}`, 500, {}, ErrorCodes.INTERNAL_ERROR);
  }

  const enrichSkillRels = async (rows, idField) => {
    const results = [];
    for (const row of rows) {
      const sid = row[idField];
      let sname = sid;
      try {
        const { data } = await supabase.from('skills').select('skill_name').eq('id', sid).limit(1);
        if (data && data.length > 0) sname = data[0].skill_name ?? sid;
      } catch (_) {}
      results.push({ ...row, [`${idField}_name`]: sname });
    }
    return results;
  };

  const enrichRoles = async (rows) => {
    const results = [];
    for (const row of rows) {
      let roleName = row.role_id;
      try {
        const { data } = await supabase.from('roles').select('role_name').eq('id', row.role_id).limit(1);
        if (data && data.length > 0) roleName = data[0].role_name ?? row.role_id;
      } catch (_) {}
      results.push({ ...row, role_name: roleName });
    }
    return results;
  };

  const [prerequisites, advancedSkills, roles] = await Promise.all([
    enrichSkillRels(prereqResult.data ?? [], 'related_skill_id'),
    enrichSkillRels(advancedResult.data ?? [], 'skill_id'),
    enrichRoles(rolesResult.data ?? []),
  ]);

  res.json({
    success: true,
    data: { skill, prerequisites, advanced_skills: advancedSkills, roles },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. CAREER PATH SIMULATOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/admin/graph-intelligence/simulate-path
 */
const simulatePath = asyncHandler(async (req, res) => {
  const { current_role_id, target_role_id, max_hops = 6 } = req.body;

  if (!current_role_id || !target_role_id) {
    throw new AppError('current_role_id and target_role_id are required', 400, {}, ErrorCodes.VALIDATION_ERROR);
  }
  if (current_role_id === target_role_id) {
    throw new AppError('current_role_id and target_role_id must be different', 400, {}, ErrorCodes.VALIDATION_ERROR);
  }

  const supabase = getDb();

  // BFS over role_transitions to find shortest path
  const visited = new Set();
  const queue   = [[current_role_id]];
  let foundPath = null;

  outer:
  while (queue.length > 0) {
    const path    = queue.shift();
    const current = path[path.length - 1];

    if (visited.has(current)) continue;
    visited.add(current);
    if (path.length > max_hops + 1) continue;

    const { data: transitions, error } = await supabase
      .from('role_transitions').select('to_role_id').eq('from_role_id', current);

    if (error) throw new AppError(`DB error during BFS: ${error.message}`, 500, {}, ErrorCodes.INTERNAL_ERROR);

    for (const row of transitions ?? []) {
      const next = row.to_role_id;
      if (next === target_role_id) { foundPath = [...path, next]; break outer; }
      if (!visited.has(next) && path.length < max_hops + 1) queue.push([...path, next]);
    }
  }

  if (!foundPath) {
    return res.json({
      success: true,
      data: {
        found: false,
        message: `No path found from "${current_role_id}" to "${target_role_id}" within ${max_hops} hops.`,
        path: [], steps: [],
      },
    });
  }

  // Enrich path with role details and transition metadata
  const steps = [];

  for (let i = 0; i < foundPath.length; i++) {
    const roleId = foundPath[i];

    const { data: roleRows, error: roleErr } = await supabase
      .from('roles').select('*').eq('id', roleId).limit(1);
    if (roleErr) throw new AppError(`DB error fetching role: ${roleErr.message}`, 500, {}, ErrorCodes.INTERNAL_ERROR);

    const roleData = (roleRows && roleRows.length > 0) ? roleRows[0] : { role_name: roleId };

    let transition = null;
    if (i < foundPath.length - 1) {
      const nextId = foundPath[i + 1];
      const { data: tRows, error: tErr } = await supabase
        .from('role_transitions').select('*').eq('from_role_id', roleId).eq('to_role_id', nextId).limit(1);
      if (tErr) throw new AppError(`DB error fetching transition: ${tErr.message}`, 500, {}, ErrorCodes.INTERNAL_ERROR);
      if (tRows && tRows.length > 0) transition = tRows[0];
    }

    // Skills for this role (first 10)
    const { data: skillMappings, error: smErr } = await supabase
      .from('role_skills').select('skill_id').eq('role_id', roleId).limit(10);
    if (smErr) throw new AppError(`DB error fetching role skills: ${smErr.message}`, 500, {}, ErrorCodes.INTERNAL_ERROR);

    const skillIds = (skillMappings ?? []).map(s => s.skill_id).filter(Boolean);
    const skills   = [];

    if (skillIds.length > 0) {
      const { data: skillRows, error: skErr } = await supabase
        .from('skills').select('skill_id, skill_name').in('skill_id', skillIds);
      if (!skErr) {
        for (const s of skillRows ?? []) skills.push({ skill_id: s.skill_id, skill_name: s.skill_name });
      }
    }

    steps.push({
      step:               i + 1,
      role_id:            roleId,
      role_name:          roleData.role_name      ?? roleId,
      role_family:        roleData.role_family     ?? null,
      seniority:          roleData.seniority_level ?? null,
      skills,
      transition_to_next: transition,
    });
  }

  res.json({
    success: true,
    data: {
      found: true, hops: foundPath.length - 1, path: foundPath, steps,
      current_role: steps[0]?.role_name,
      target_role:  steps[steps.length - 1]?.role_name,
    },
  });
});

/**
 * GET /api/v1/admin/graph-intelligence/roles/search?q=
 */
const searchRoles = asyncHandler(async (req, res) => {
  const { q = '', limit = 20 } = req.query;
  const supabase = getDb();

  let query = supabase
    .from('roles')
    .select('id, role_id, role_name, role_family, seniority_level')
    .order('role_name')
    .limit(parseInt(limit, 10));

  if (q.trim()) {
    // Prefix search — equivalent to Firestore startAt/endAt('role_name') pattern
    query = query.ilike('role_name', `${q.trim()}%`);
  }

  const { data, error } = await query;
  if (error) throw new AppError(`DB error searching roles: ${error.message}`, 500, {}, ErrorCodes.INTERNAL_ERROR);

  const roles = (data ?? []).map(d => ({
    id:          d.id,
    role_id:     d.role_id    ?? d.id,
    role_name:   d.role_name  ?? d.id,
    role_family: d.role_family ?? null,
    seniority:   d.seniority_level ?? null,
  }));

  res.json({ success: true, data: { roles, count: roles.length } });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. ROLE IMPACT ANALYZER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/graph-intelligence/role-impact/:roleId
 */
const getRoleImpact = asyncHandler(async (req, res) => {
  const { roleId } = req.params;
  const supabase   = getDb();

  const { data: roleRows, error: roleErr } = await supabase
    .from('roles').select('*').eq('id', roleId).limit(1);

  if (roleErr) throw new AppError(`DB error: ${roleErr.message}`, 500, {}, ErrorCodes.INTERNAL_ERROR);
  if (!roleRows || roleRows.length === 0) {
    throw new AppError(`Role not found: ${roleId}`, 404, { roleId }, ErrorCodes.NOT_FOUND);
  }
  const role = roleRows[0];

  const [outgoingResult, incomingResult, skillsResult, salaryResult, educationResult] = await Promise.all([
    supabase.from('role_transitions').select('*').eq('from_role_id', roleId),
    supabase.from('role_transitions').select('*').eq('to_role_id', roleId),
    supabase.from('role_skills').select('*').eq('role_id', roleId),
    supabase.from('role_salary_market').select('*').eq('role_id', roleId),
    supabase.from('role_education').select('*').eq('role_id', roleId),
  ]);

  for (const [label, result] of [
    ['outgoing transitions', outgoingResult], ['incoming transitions', incomingResult],
    ['skills', skillsResult], ['salary', salaryResult], ['education', educationResult],
  ]) {
    if (result.error) throw new AppError(`DB error fetching ${label}: ${result.error.message}`, 500, {}, ErrorCodes.INTERNAL_ERROR);
  }

  const salaryRecords    = salaryResult.data    ?? [];
  const educationRecords = educationResult.data ?? [];
  const outgoing         = outgoingResult.data  ?? [];
  const incoming         = incomingResult.data  ?? [];
  const skills           = skillsResult.data    ?? [];

  const salaryStats = salaryRecords.length > 0 ? {
    count:     salaryRecords.length,
    countries: [...new Set(salaryRecords.map(s => s.country).filter(Boolean))],
    median_range: {
      min: Math.min(...salaryRecords.map(s => s.median_salary ?? 0).filter(v => v > 0)),
      max: Math.max(...salaryRecords.map(s => s.median_salary ?? 0).filter(v => v > 0)),
    },
  } : null;

  const educationSummary = educationRecords.map(e => ({
    education_level: e.education_level,
    match_score:     e.match_score,
  }));

  res.json({
    success: true,
    data: {
      role,
      impact: {
        outgoing_transitions: outgoing.length,
        incoming_transitions: incoming.length,
        total_transitions:    outgoing.length + incoming.length,
        skill_mappings:       skills.length,
        salary_benchmarks:    salaryRecords.length,
        education_mappings:   educationRecords.length,
      },
      salary_stats:         salaryStats,
      education_summary:    educationSummary,
      outgoing_transitions: outgoing,
      incoming_transitions: incoming,
      skill_mappings:       skills,
    },
  });
});

module.exports = {
  getCareerGraph,
  getRoleDetail,
  getSkillGraph,
  getSkillDetail,
  simulatePath,
  searchRoles,
  getRoleImpact,
};
