'use strict';

/**
 * skillDemandDataset.js — Skill Demand Data Layer
 *
 * Supabase-native dataset loader with:
 * - TTL cache
 * - concurrency-safe single-flight refresh
 * - keyset pagination
 * - partial-match role index
 * - graceful fallback semantics
 *
 * Column mapping (role_skills):
 *   role     → role_id
 *   skill    → skill_id
 *   priority → importance_weight
 */

const logger = require('../../../utils/logger');
const { supabase } = require('../../../config/supabase');

const SKILL_DEMAND_TABLE = 'skill_demand';
const ROLE_SKILLS_TABLE = 'role_skills';
const PAGE_SIZE = 1000;
const CACHE_TTL_MS = Number.parseInt(
  process.env.SKILL_DEMAND_CACHE_TTL_MS || '3600000',
  10
);

const cache = {
  skillDemand: null,
  roleSkills: null,
  roleKeys: null,
  loadedAt: 0,
  refreshPromise: null,
};

function normalise(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/[_\-/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function loadSkillDemandFromSupabase() {
  const map = new Map();
  let lastSkill = null;

  while (true) {
    let query = supabase
      .from(SKILL_DEMAND_TABLE)
      .select('skill,demand_score,growth_rate,salary_boost,industry')
      .order('skill', { ascending: true })
      .limit(PAGE_SIZE);

    if (lastSkill) {
      query = query.gt('skill', lastSkill);
    }

    const { data, error } = await query;

    if (error) {
      logger.warn('[SkillDemandDataset] skill_demand unavailable', {
        error: error.message,
        code: error.code,
      });
      return map;
    }

    if (!data?.length) break;

    for (const row of data) {
      if (!row?.skill) continue;

      map.set(normalise(row.skill), {
        skill: row.skill,
        demand_score: Number(row.demand_score) || 0,
        growth_rate: Number(row.growth_rate) || 0,
        salary_boost: Number(row.salary_boost) || 0,
        industry: row.industry || 'General',
      });
    }

    if (data.length < PAGE_SIZE) break;
    lastSkill = data[data.length - 1].skill;
  }

  return map;
}

async function loadRoleSkillsFromSupabase() {
  const map = new Map();
  let lastRoleId = null;
  let lastWeight = null;

  while (true) {
    let query = supabase
      .from(ROLE_SKILLS_TABLE)
      .select('role_id,skill_id,importance_weight')
      .order('role_id', { ascending: true })
      .order('importance_weight', { ascending: true })
      .limit(PAGE_SIZE);

    if (lastRoleId !== null) {
      query = query.or(
        `role_id.gt.${lastRoleId},and(role_id.eq.${lastRoleId},importance_weight.gt.${lastWeight ?? 0})`
      );
    }

    const { data, error } = await query;

    if (error) {
      logger.warn('[SkillDemandDataset] role_skills unavailable', {
        error: error.message,
        code: error.code,
      });
      return map;
    }

    if (!data?.length) break;

    for (const row of data) {
      if (!row?.role_id || !row?.skill_id) continue;

      const key = normalise(row.role_id);

      if (!map.has(key)) {
        map.set(key, []);
      }

      map.get(key).push(row.skill_id);
    }

    if (data.length < PAGE_SIZE) break;

    const last = data[data.length - 1];
    lastRoleId = last.role_id;
    lastWeight = last.importance_weight ?? 0;
  }

  return map;
}

function buildRoleKeyIndex(roleSkillsMap) {
  return Array.from(roleSkillsMap.keys());
}

async function refreshDatasets() {
  const [skillDemand, roleSkills] = await Promise.all([
    loadSkillDemandFromSupabase(),
    loadRoleSkillsFromSupabase(),
  ]);

  cache.skillDemand = skillDemand;
  cache.roleSkills = roleSkills;
  cache.roleKeys = buildRoleKeyIndex(roleSkills);
  cache.loadedAt = Date.now();

  logger.info('[SkillDemandDataset] Datasets loaded', {
    skillDemandCount: skillDemand.size,
    roleSkillsCount: roleSkills.size,
  });

  return { skillDemand, roleSkills };
}

async function loadDatasets() {
  const now = Date.now();
  const cacheFresh =
    cache.skillDemand &&
    cache.roleSkills &&
    now - cache.loadedAt < CACHE_TTL_MS;

  if (cacheFresh) {
    return {
      skillDemand: cache.skillDemand,
      roleSkills: cache.roleSkills,
    };
  }

  if (!cache.refreshPromise) {
    logger.debug('[SkillDemandDataset] Refreshing Supabase datasets');

    cache.refreshPromise = refreshDatasets()
      .catch((error) => {
        logger.error('[SkillDemandDataset] Refresh failed', {
          error: error.message,
        });

        if (cache.skillDemand && cache.roleSkills) {
          return {
            skillDemand: cache.skillDemand,
            roleSkills: cache.roleSkills,
          };
        }

        throw error;
      })
      .finally(() => {
        cache.refreshPromise = null;
      });
  }

  return cache.refreshPromise;
}

function invalidateCache() {
  cache.skillDemand = null;
  cache.roleSkills = null;
  cache.roleKeys = null;
  cache.loadedAt = 0;
  cache.refreshPromise = null;

  logger.info('[SkillDemandDataset] Cache invalidated');
}

function lookupSkillDemand(skillDemandMap, skillName) {
  return skillDemandMap.get(normalise(skillName)) ?? null;
}

function lookupRoleSkills(roleSkillsMap, roleName) {
  const normRole = normalise(roleName);

  const exact = roleSkillsMap.get(normRole);
  if (exact) return exact;

  const keys = cache.roleKeys || Array.from(roleSkillsMap.keys());

  for (const key of keys) {
    if (key.includes(normRole) || normRole.includes(key)) {
      return roleSkillsMap.get(key) || [];
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