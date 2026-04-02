'use strict';

/**
 * skillDemandDataset.js — Skill Demand Data Layer
 *
 * MIGRATED: Previously read from CSV files on disk (src/data/role-skills.csv,
 * src/data/skills-demand-india.csv). Now reads from Supabase tables:
 *   - skill_demand   (was skills-demand-india.csv)
 *   - role_skills    (was role-skills.csv)
 *
 * WHY SUPABASE INSTEAD OF CSV:
 *   1. No redeploy needed to update skill/role data
 *   2. Works on all cloud platforms (no filesystem dependency)
 *   3. Supports admin UI updates without code changes
 *   4. Properly indexed for fast lookups at scale
 *   5. CSV had wrong skill names causing 0% match scores (e.g. "Tally" vs "Tally ERP")
 *
 * In-memory cache (1 hour TTL) preserved — same interface as before so
 * skillDemand.service.js needs no changes.
 *
 * @module modules/skillDemand/repository/skillDemandDataset
 */

const logger = require('../../../utils/logger');

// Lazy-load supabase to avoid issues in test mode
function getSupabase() {
  const { supabase } = require('../../../config/supabase'); return supabase;
}

// ─── Cache ────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = parseInt(process.env.SKILL_DEMAND_CACHE_TTL_MS || '3600000', 10); // 1 hour

const _cache = {
  skillDemand: null,   // Map<normalizedSkillName, SkillDemandRecord>
  roleSkills:  null,   // Map<normalizedRoleName, string[]>
  loadedAt:    null,
};

// ─── Normalisation ────────────────────────────────────────────────────────────

function normalise(name) {
  return (name || '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/[_\-/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Supabase Loaders ─────────────────────────────────────────────────────────

async function _loadSkillDemandFromSupabase() {
  const supabase = getSupabase();
  const map = new Map();

  // Fetch in pages to handle large datasets
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('skill_demand')
      .select('skill, demand_score, growth_rate, salary_boost, industry')
      .range(from, from + PAGE - 1);

    if (error) {
      logger.debug('[SkillDemandDataset] skill_demand table not found — using static fallback', { error: error.message });
      return map; // return empty map so static benchmarks take over
      break;
    }
    if (!data || data.length === 0) break;

    for (const row of data) {
      if (!row.skill) continue;
      map.set(normalise(row.skill), {
        skill:        row.skill,
        demand_score: parseFloat(row.demand_score) || 0,
        growth_rate:  parseFloat(row.growth_rate)  || 0,
        salary_boost: parseFloat(row.salary_boost) || 0,
        industry:     row.industry || 'General',
      });
    }

    if (data.length < PAGE) break;
    from += PAGE;
  }

  return map;
}

async function _loadRoleSkillsFromSupabase() {
  const supabase = getSupabase();
  const map = new Map(); // normalised role → string[] of skill names

  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('role_skills')
      .select('role, skill, is_required, priority')
      .order('role')
      .order('priority')
      .range(from, from + PAGE - 1);

    if (error) {
      logger.debug('[SkillDemandDataset] role_skills table not found — using static fallback', { error: error.message });
      return map; // return empty map so static benchmarks take over
      break;
    }
    if (!data || data.length === 0) break;

    for (const row of data) {
      if (!row.role || !row.skill) continue;
      const key = normalise(row.role);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row.skill);
    }

    if (data.length < PAGE) break;
    from += PAGE;
  }

  return map;
}

// ─── Public Loader ────────────────────────────────────────────────────────────

async function loadDatasets() {
  const now = Date.now();

  // Return from cache if still fresh
  if (_cache.skillDemand && _cache.roleSkills && _cache.loadedAt) {
    if (now - _cache.loadedAt < CACHE_TTL_MS) {
      return { skillDemand: _cache.skillDemand, roleSkills: _cache.roleSkills };
    }
  }

  logger.debug('[SkillDemandDataset] Loading datasets from Supabase...');

  const [skillDemand, roleSkills] = await Promise.all([
    _loadSkillDemandFromSupabase(),
    _loadRoleSkillsFromSupabase(),
  ]);

  _cache.skillDemand = skillDemand;
  _cache.roleSkills  = roleSkills;
  _cache.loadedAt    = now;

  logger.info('[SkillDemandDataset] Datasets loaded', {
    skillDemandCount: _cache.skillDemand.size,
    roleSkillsCount:  _cache.roleSkills.size,
  });

  return { skillDemand: _cache.skillDemand, roleSkills: _cache.roleSkills };
}

function invalidateCache() {
  _cache.skillDemand = null;
  _cache.roleSkills  = null;
  _cache.loadedAt    = null;
  logger.info('[SkillDemandDataset] Cache invalidated');
}

function lookupSkillDemand(skillDemandMap, skillName) {
  return skillDemandMap.get(normalise(skillName)) ?? null;
}

function lookupRoleSkills(roleSkillsMap, roleName) {
  const normRole = normalise(roleName);

  // 1. Exact match
  if (roleSkillsMap.has(normRole)) {
    return roleSkillsMap.get(normRole);
  }

  // 2. Partial match
  for (const [key, skills] of roleSkillsMap.entries()) {
    if (key.includes(normRole) || normRole.includes(key)) {
      return skills;
    }
  }

  return [];
}

module.exports = {
  loadDatasets,
  invalidateCache,
  lookupSkillDemand,
  lookupRoleSkills,
  normalise,
};
