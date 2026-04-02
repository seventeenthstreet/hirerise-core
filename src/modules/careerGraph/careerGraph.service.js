'use strict';

const careerGraph = require('./CareerGraph');
const logger = require('../../utils/logger');
const cache = require('../../utils/cache');

const CACHE_TTL = 1800;

function normalizeRoleId(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeTransitionOpts(opts = {}) {
  return {
    types: Array.isArray(opts.types) ? opts.types : null,
    maxDifficulty:
      typeof opts.maxDifficulty === 'number'
        ? Math.max(0, Math.min(100, opts.maxDifficulty))
        : 100,
    maxHops:
      typeof opts.maxHops === 'number'
        ? Math.max(1, Math.min(6, opts.maxHops))
        : 4,
  };
}

async function getRole(roleId) {
  const normalizedRoleId = normalizeRoleId(roleId);
  const cacheKey = `cg:role:${normalizedRoleId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const node =
    careerGraph.getRole(normalizedRoleId) ||
    careerGraph.resolveRole(normalizedRoleId);

  if (node) cache.set(cacheKey, node, CACHE_TTL);
  return node;
}

async function searchRoles(query, limit = 15) {
  if (!query || !String(query).trim()) {
    return careerGraph.allRoles().slice(0, limit);
  }
  return careerGraph.searchRoles(query, limit);
}

async function getRolesByFamily(family) {
  return careerGraph.getRolesByFamily(String(family).trim());
}

async function getRoleFamilies() {
  return careerGraph.getRoleFamilies();
}

async function getSkillsForRole(roleId) {
  const normalizedRoleId = normalizeRoleId(roleId);
  const cacheKey = `cg:skills:${normalizedRoleId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const skills = careerGraph.getSkillsForRole(normalizedRoleId);

  logger.debug('[CareerGraphService] getSkillsForRole', {
    roleId: normalizedRoleId,
    count: skills.length,
  });

  cache.set(cacheKey, skills, CACHE_TTL);
  return skills;
}

async function getSkillGap(userSkills, roleId) {
  const normalizedRoleId = normalizeRoleId(roleId);
  const result = careerGraph.getSkillGap(userSkills, normalizedRoleId);

  logger.debug('[CareerGraphService] getSkillGap', {
    roleId: normalizedRoleId,
    userSkillCount: userSkills.length,
    matchPct: result.required_match_pct,
  });

  return result;
}

async function getTransitions(fromRoleId, opts = {}) {
  const normalizedRoleId = normalizeRoleId(fromRoleId);
  const normalizedOpts = normalizeTransitionOpts(opts);

  return careerGraph.getTransitions(normalizedRoleId, normalizedOpts);
}

async function getCareerPath(fromRoleId, opts = {}) {
  const normalizedRoleId = normalizeRoleId(fromRoleId);
  const normalizedOpts = normalizeTransitionOpts(opts);

  const cacheKey = [
    'cg:path',
    normalizedRoleId,
    normalizedOpts.maxHops,
    normalizedOpts.maxDifficulty,
    (normalizedOpts.types || []).join('|'),
  ].join(':');

  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const result = careerGraph.getCareerPath(
    normalizedRoleId,
    normalizedOpts
  );

  cache.set(cacheKey, result, CACHE_TTL);
  return result;
}

async function getSalaryBenchmark(roleId, opts = {}) {
  const normalizedRoleId = normalizeRoleId(roleId);

  const cacheKey = `cg:salary:${normalizedRoleId}:${opts.country || 'IN'}:${opts.experienceYears || 'na'}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const result = careerGraph.getSalaryBenchmark(normalizedRoleId, opts);
  if (result) cache.set(cacheKey, result, CACHE_TTL);
  return result;
}

async function getSalaryPosition(roleId, currentSalaryAnnual, opts = {}) {
  return careerGraph.getSalaryPosition(
    normalizeRoleId(roleId),
    currentSalaryAnnual,
    opts
  );
}

async function getEducationMatch(roleId, educationLevel) {
  return careerGraph.getEducationMatch(
    normalizeRoleId(roleId),
    educationLevel
  );
}

async function computeGraphCHI(profile) {
  let normalized = { ...profile };

  if (!normalized.targetRoleId && normalized.targetRoleName) {
    const node = careerGraph.resolveRole(normalized.targetRoleName);
    if (node) normalized.targetRoleId = node.role_id;
  }

  if (!normalized.currentRoleId && normalized.currentRoleName) {
    const node = careerGraph.resolveRole(normalized.currentRoleName);
    if (node) normalized.currentRoleId = node.role_id;
  }

  if (normalized.targetRoleId) {
    normalized.targetRoleId = normalizeRoleId(normalized.targetRoleId);
  }

  if (normalized.currentRoleId) {
    normalized.currentRoleId = normalizeRoleId(normalized.currentRoleId);
  }

  return careerGraph.computeCHI(normalized);
}

async function computeOnboardingInsights(profile) {
  let normalized = { ...profile };

  if (!normalized.targetRoleId && normalized.targetRoleName) {
    const node = careerGraph.resolveRole(normalized.targetRoleName);
    if (node) normalized.targetRoleId = node.role_id;
  }

  if (!normalized.currentRoleId && normalized.currentRoleName) {
    const node = careerGraph.resolveRole(normalized.currentRoleName);
    if (node) normalized.currentRoleId = node.role_id;
  }

  if (!normalized.targetRoleId) return null;

  normalized.targetRoleId = normalizeRoleId(normalized.targetRoleId);

  if (normalized.currentRoleId) {
    normalized.currentRoleId = normalizeRoleId(normalized.currentRoleId);
  }

  logger.debug('[CareerGraphService] computeOnboardingInsights', {
    targetRoleId: normalized.targetRoleId,
    currentRoleId: normalized.currentRoleId,
  });

  return careerGraph.computeOnboardingInsights(normalized);
}

module.exports = {
  getRole,
  searchRoles,
  getRolesByFamily,
  getRoleFamilies,
  getSkillsForRole,
  getSkillGap,
  getTransitions,
  getCareerPath,
  getSalaryBenchmark,
  getSalaryPosition,
  getEducationMatch,
  computeGraphCHI,
  computeOnboardingInsights,
};