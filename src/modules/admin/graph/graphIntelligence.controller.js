'use strict';

/**
 * graphIntelligence.controller.js — FINAL Production Version + Redis Cache
 */

const { asyncHandler } = require('../../../utils/helpers');
const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');
const logger = require('../../../utils/logger');
const { getCache, setCache } = require('../../../utils/cache.util');

function getClient() {
  return require('../../../config/supabase');
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

async function fetchAll(supabase, table, select = '*', limit = 5000) {
  const { data = [], error } = await supabase
    .from(table)
    .select(select)
    .limit(limit);

  if (error) throw error;
  return data;
}

async function fetchWhere(supabase, table, col, val, select = '*') {
  const { data = [], error } = await supabase
    .from(table)
    .select(select)
    .eq(col, val);

  if (error) throw error;
  return data;
}

async function fetchById(supabase, table, idCol, id) {
  const { data, error } = await supabase
    .from(table)
    .select('*')
    .eq(idCol, id)
    .maybeSingle();

  if (error) throw error;
  return data;
}

// ─────────────────────────────────────────────────────────────
// 1. CAREER GRAPH (CACHED)
// ─────────────────────────────────────────────────────────────

const getCareerGraph = asyncHandler(async (_req, res) => {
  const start = Date.now();
  const supabase = getClient();
  const cacheKey = 'graph:career';

  try {
    const cached = await getCache(cacheKey);

    if (cached) {
      logger.info('[Cache] HIT getCareerGraph');
      return res.json({
        success: true,
        cached: true,
        meta: { duration_ms: Date.now() - start },
        data: cached,
      });
    }

    logger.info('[Cache] MISS getCareerGraph');

    const [roles, transitions] = await Promise.all([
      fetchAll(supabase, 'roles'),
      fetchAll(supabase, 'role_transitions'),
    ]);

    const result = {
      roles: roles.filter((r) => r.name || r.role_name),
      transitions,
      node_count: roles.length,
      edge_count: transitions.length,
    };

    await setCache(cacheKey, result, 300);

    res.json({
      success: true,
      cached: false,
      meta: { duration_ms: Date.now() - start },
      data: result,
    });

  } catch (err) {
    logger.error('[GraphIntel] getCareerGraph failed', { error: err.message });
    throw err;
  }
});

// ─────────────────────────────────────────────────────────────
// 2. ROLE DETAIL
// ─────────────────────────────────────────────────────────────

const getRoleDetail = asyncHandler(async (req, res) => {
  const start = Date.now();
  const supabase = getClient();
  const { roleId } = req.params;

  try {
    const role = await fetchById(supabase, 'roles', 'role_id', roleId);

    if (!role) {
      throw new AppError(
        `Role not found: ${roleId}`,
        404,
        {},
        ErrorCodes.NOT_FOUND
      );
    }

    const [skills, outgoing, incoming, salary, education] = await Promise.all([
      fetchWhere(supabase, 'role_skills',        'role_id',      roleId),
      fetchWhere(supabase, 'role_transitions',   'from_role_id', roleId),
      fetchWhere(supabase, 'role_transitions',   'to_role_id',   roleId),
      fetchWhere(supabase, 'role_salary_market', 'role_id',      roleId),
      fetchWhere(supabase, 'role_education',     'role_id',      roleId),
    ]);

    res.json({
      success: true,
      meta: { duration_ms: Date.now() - start },
      data: {
        role,
        skills,
        outgoing_transitions: outgoing,
        incoming_transitions: incoming,
        salary,
        education,
      },
    });

  } catch (err) {
    logger.error('[GraphIntel] getRoleDetail failed', {
      roleId,
      error: err.message,
    });
    throw err;
  }
});

// ─────────────────────────────────────────────────────────────
// 3. SKILL GRAPH (CACHED)
// ─────────────────────────────────────────────────────────────

const getSkillGraph = asyncHandler(async (_req, res) => {
  const start = Date.now();
  const supabase = getClient();
  const cacheKey = 'graph:skills';

  try {
    const cached = await getCache(cacheKey);

    if (cached) {
      logger.info('[Cache] HIT getSkillGraph');
      return res.json({
        success: true,
        cached: true,
        meta: { duration_ms: Date.now() - start },
        data: cached,
      });
    }

    logger.info('[Cache] MISS getSkillGraph');

    const [skills, relationships] = await Promise.all([
      fetchAll(supabase, 'skills'),
      fetchAll(supabase, 'skill_relationships'),
    ]);

    const result = {
      skills: skills.filter((s) => s.name || s.skill_name),
      relationships,
      node_count: skills.length,
      edge_count: relationships.length,
    };

    await setCache(cacheKey, result, 300);

    res.json({
      success: true,
      cached: false,
      meta: { duration_ms: Date.now() - start },
      data: result,
    });

  } catch (err) {
    logger.error('[GraphIntel] getSkillGraph failed', { error: err.message });
    throw err;
  }
});

// ─────────────────────────────────────────────────────────────
// 4. SKILL DETAIL
// ─────────────────────────────────────────────────────────────

const getSkillDetail = asyncHandler(async (req, res) => {
  const start = Date.now();
  const supabase = getClient();
  const { skillId } = req.params;

  try {
    const skill = await fetchById(supabase, 'skills', 'skill_id', skillId);

    if (!skill) {
      throw new AppError(
        `Skill not found: ${skillId}`,
        404,
        {},
        ErrorCodes.NOT_FOUND
      );
    }

    const [relationships, roleSkills] = await Promise.all([
      fetchWhere(supabase, 'skill_relationships', 'skill_id', skillId),
      fetchWhere(supabase, 'role_skills',         'skill_id', skillId),
    ]);

    logger.info('[GraphIntel] getSkillDetail completed', {
      skillId,
      duration_ms: Date.now() - start,
    });

    res.json({
      success: true,
      meta: { duration_ms: Date.now() - start },
      data: {
        skill,
        relationships,
        roles: roleSkills,
      },
    });

  } catch (err) {
    logger.error('[GraphIntel] getSkillDetail failed', {
      skillId,
      error: err.message,
    });
    throw err;
  }
});

// ─────────────────────────────────────────────────────────────
// 5. PATH SIMULATION
// ─────────────────────────────────────────────────────────────

const simulatePath = asyncHandler(async (req, res) => {
  const start = Date.now();
  const supabase = getClient();

  const { current_role_id, target_role_id, max_hops = 6 } = req.body;

  logger.info('[GraphIntel] simulatePath started', {
    current_role_id,
    target_role_id,
  });

  try {
    const { data: transitions = [], error } = await supabase
      .from('role_transitions')
      .select('from_role_id, to_role_id');

    if (error) throw error;

    const adj = {};
    for (const t of transitions) {
      if (!adj[t.from_role_id]) adj[t.from_role_id] = [];
      adj[t.from_role_id].push(t.to_role_id);
    }

    const visited = new Set();
    const queue   = [[current_role_id]];
    let foundPath = null;

    while (queue.length && !foundPath) {
      const path    = queue.shift();
      const current = path[path.length - 1];

      if (visited.has(current) || path.length > max_hops + 1) continue;

      visited.add(current);

      for (const next of (adj[current] || [])) {
        if (next === target_role_id) {
          foundPath = [...path, next];
          break;
        }
        if (!visited.has(next)) queue.push([...path, next]);
      }
    }

    logger.info('[GraphIntel] simulatePath completed', {
      duration_ms: Date.now() - start,
      found: !!foundPath,
    });

    res.json({
      success: true,
      meta: { duration_ms: Date.now() - start },
      data: {
        found: !!foundPath,
        path:  foundPath || [],
      },
    });

  } catch (err) {
    logger.error('[GraphIntel] simulatePath failed', { error: err.message });
    throw err;
  }
});

// ─────────────────────────────────────────────────────────────
// 6. SEARCH ROLES
// ─────────────────────────────────────────────────────────────

const searchRoles = asyncHandler(async (req, res) => {
  const start = Date.now();
  const supabase = getClient();

  const { q = '', limit = 20 } = req.query;
  const limitInt = Math.min(parseInt(limit, 10) || 20, 50);

  try {
    let query = supabase
      .from('roles')
      .select('role_id, role_name, name')
      .limit(limitInt);

    if (q) {
      query = query.or(`role_name.ilike.%${q}%,name.ilike.%${q}%`);
    }

    const { data = [], error } = await query;

    if (error) throw error;

    logger.info('[GraphIntel] searchRoles completed', {
      duration_ms: Date.now() - start,
      results: data.length,
    });

    res.json({
      success: true,
      meta: { duration_ms: Date.now() - start },
      data,
    });

  } catch (err) {
    logger.error('[GraphIntel] searchRoles failed', { error: err.message });
    throw err;
  }
});

// ─────────────────────────────────────────────────────────────
// 7. ROLE IMPACT
// Analyzes how central a role is in the career graph:
// - how many roles transition into it (incoming)
// - how many roles it leads to (outgoing)
// - which skills are associated with it
// ─────────────────────────────────────────────────────────────

const getRoleImpact = asyncHandler(async (req, res) => {
  const start = Date.now();
  const supabase = getClient();
  const { roleId } = req.params;

  logger.info('[GraphIntel] getRoleImpact started', { roleId });

  try {
    const role = await fetchById(supabase, 'roles', 'role_id', roleId);

    if (!role) {
      throw new AppError(
        `Role not found: ${roleId}`,
        404,
        {},
        ErrorCodes.NOT_FOUND
      );
    }

    const [outgoing, incoming, skills] = await Promise.all([
      fetchWhere(supabase, 'role_transitions', 'from_role_id', roleId),
      fetchWhere(supabase, 'role_transitions', 'to_role_id',   roleId),
      fetchWhere(supabase, 'role_skills',      'role_id',      roleId),
    ]);

    logger.info('[GraphIntel] getRoleImpact completed', {
      roleId,
      duration_ms:   Date.now() - start,
      outgoing:      outgoing.length,
      incoming:      incoming.length,
      skills:        skills.length,
    });

    res.json({
      success: true,
      meta: { duration_ms: Date.now() - start },
      data: {
        role,
        impact: {
          outgoing_paths: outgoing.length,
          incoming_paths: incoming.length,
          skills_count:   skills.length,
          transitions: { outgoing, incoming },
          skills,
        },
      },
    });

  } catch (err) {
    logger.error('[GraphIntel] getRoleImpact failed', {
      roleId,
      error: err.message,
    });
    throw err;
  }
});

// ─────────────────────────────────────────────────────────────
// 8. MARKET INTELLIGENCE
// Returns salary market data, optionally filtered by country.
// ─────────────────────────────────────────────────────────────

const getMarketIntelligence = asyncHandler(async (req, res) => {
  const start = Date.now();
  const supabase = getClient();
  const { country } = req.query;

  logger.info('[GraphIntel] getMarketIntelligence started', { country });

  try {
    let query = supabase.from('role_salary_market').select('*');

    if (country) {
      query = query.eq('country', country);
    }

    const { data = [], error } = await query;

    if (error) throw error;

    logger.info('[GraphIntel] getMarketIntelligence completed', {
      duration_ms: Date.now() - start,
      results:     data.length,
      country:     country || 'all',
    });

    res.json({
      success: true,
      meta: { duration_ms: Date.now() - start },
      data: {
        market_intelligence: data,
        country: country || 'all',
        total:   data.length,
      },
    });

  } catch (err) {
    logger.error('[GraphIntel] getMarketIntelligence failed', {
      error: err.message,
    });
    throw err;
  }
});

// ─────────────────────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────────────────────

module.exports = {
  getCareerGraph,
  getRoleDetail,
  getSkillGraph,
  getSkillDetail,
  simulatePath,
  searchRoles,
  getRoleImpact,
  getMarketIntelligence,
};