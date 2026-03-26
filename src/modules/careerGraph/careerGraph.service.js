'use strict';

/**
 * careerGraph.service.js — Career Graph Application Service
 *
 * Thin application-layer service wrapping the CareerGraph engine.
 * Handles input validation, logging, caching, and shapes responses
 * for controllers. All graph intelligence lives in CareerGraph.js.
 *
 * Consumed by:
 *   - careerGraph.controller.js (HTTP API)
 *   - skillGap.service.js       (skills/role/:roleId enrichment)
 *   - careerPath.service.js     (replaces static JSON repo)
 *   - careerHealthIndex.service.js (deterministic CHI enrichment)
 *   - onboarding.intake.service.js (onboarding insight cards)
 */

const careerGraph = require('./CareerGraph');
const logger      = require('../../utils/logger');
const cache       = require('../../utils/cache');

const CACHE_TTL = 1800; // 30 min — graph data changes rarely

// ─── Role lookup ──────────────────────────────────────────────────────────────

async function getRole(roleId) {
  const cacheKey = `cg:role:${roleId}`;
  const cached   = cache.get(cacheKey);
  if (cached) return cached;

  const node = careerGraph.getRole(roleId) || careerGraph.resolveRole(roleId);
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
  return careerGraph.getRolesByFamily(family);
}

async function getRoleFamilies() {
  return careerGraph.getRoleFamilies();
}

// ─── Skills ───────────────────────────────────────────────────────────────────

async function getSkillsForRole(roleId) {
  const cacheKey = `cg:skills:${roleId}`;
  const cached   = cache.get(cacheKey);
  if (cached) return cached;

  const skills = careerGraph.getSkillsForRole(roleId);

  logger.debug('[CareerGraphService] getSkillsForRole', { roleId, count: skills.length });

  cache.set(cacheKey, skills, CACHE_TTL);
  return skills;
}

async function getSkillGap(userSkills, roleId) {
  if (!roleId) throw new Error('roleId is required');
  if (!Array.isArray(userSkills)) throw new Error('userSkills must be an array');

  const result = careerGraph.getSkillGap(userSkills, roleId);

  logger.debug('[CareerGraphService] getSkillGap', {
    roleId,
    userSkillCount: userSkills.length,
    matchPct: result.required_match_pct,
  });

  return result;
}

// ─── Transitions ──────────────────────────────────────────────────────────────

async function getTransitions(fromRoleId, opts = {}) {
  if (!fromRoleId) throw new Error('fromRoleId is required');
  return careerGraph.getTransitions(fromRoleId, opts);
}

async function getCareerPath(fromRoleId, opts = {}) {
  if (!fromRoleId) throw new Error('fromRoleId is required');

  const cacheKey = `cg:path:${fromRoleId}:${opts.maxHops || 4}`;
  const cached   = cache.get(cacheKey);
  if (cached) return cached;

  const result = careerGraph.getCareerPath(fromRoleId, opts);
  cache.set(cacheKey, result, CACHE_TTL);
  return result;
}

// ─── Salary ───────────────────────────────────────────────────────────────────

async function getSalaryBenchmark(roleId, opts = {}) {
  if (!roleId) throw new Error('roleId is required');

  const cacheKey = `cg:salary:${roleId}:${opts.country || 'IN'}:${opts.experienceYears || 'na'}`;
  const cached   = cache.get(cacheKey);
  if (cached) return cached;

  const result = careerGraph.getSalaryBenchmark(roleId, opts);
  if (result) cache.set(cacheKey, result, CACHE_TTL);
  return result;
}

async function getSalaryPosition(roleId, currentSalaryAnnual, opts = {}) {
  if (!roleId) throw new Error('roleId is required');
  return careerGraph.getSalaryPosition(roleId, currentSalaryAnnual, opts);
}

// ─── Education ────────────────────────────────────────────────────────────────

async function getEducationMatch(roleId, educationLevel) {
  if (!roleId) throw new Error('roleId is required');
  return careerGraph.getEducationMatch(roleId, educationLevel);
}

// ─── CHI ─────────────────────────────────────────────────────────────────────

/**
 * Compute a fully graph-powered CHI for a user profile.
 * This is the deterministic layer — it runs synchronously from graph data
 * and supplements the AI-scored CHI in careerHealthIndex.service.js.
 */
async function computeGraphCHI(profile) {
  if (!profile?.targetRoleId && !profile?.targetRoleName) {
    throw new Error('targetRoleId or targetRoleName is required for CHI computation');
  }

  // Allow role resolution by name if only name is given
  if (!profile.targetRoleId && profile.targetRoleName) {
    const node = careerGraph.resolveRole(profile.targetRoleName);
    if (node) profile = { ...profile, targetRoleId: node.role_id };
  }

  if (!profile.currentRoleId && profile.currentRoleName) {
    const node = careerGraph.resolveRole(profile.currentRoleName);
    if (node) profile = { ...profile, currentRoleId: node.role_id };
  }

  return careerGraph.computeCHI(profile);
}

/**
 * Lightweight onboarding insights — used during onboarding to power insight cards.
 * Returns CHI + career path + salary benchmark in one call.
 */
async function computeOnboardingInsights(profile) {
  if (!profile?.targetRoleId && !profile?.targetRoleName) return null;

  // Resolve names to IDs
  if (!profile.targetRoleId && profile.targetRoleName) {
    const node = careerGraph.resolveRole(profile.targetRoleName);
    if (node) profile = { ...profile, targetRoleId: node.role_id };
  }
  if (!profile.currentRoleId && profile.currentRoleName) {
    const node = careerGraph.resolveRole(profile.currentRoleName);
    if (node) profile = { ...profile, currentRoleId: node.role_id };
  }

  if (!profile.targetRoleId) return null;

  logger.debug('[CareerGraphService] computeOnboardingInsights', {
    targetRoleId: profile.targetRoleId,
    currentRoleId: profile.currentRoleId,
  });

  return careerGraph.computeOnboardingInsights(profile);
}

module.exports = {
  // Role
  getRole,
  searchRoles,
  getRolesByFamily,
  getRoleFamilies,
  // Skills
  getSkillsForRole,
  getSkillGap,
  // Transitions & paths
  getTransitions,
  getCareerPath,
  // Salary
  getSalaryBenchmark,
  getSalaryPosition,
  // Education
  getEducationMatch,
  // CHI
  computeGraphCHI,
  computeOnboardingInsights,
};








