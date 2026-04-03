'use strict';

/**
 * src/modules/jobSeeker/jobMatchingEngine.service.js
 *
 * Production-grade Supabase job matching engine
 * - Firebase legacy patterns fully removed
 * - Supabase relational joins used
 * - Cache-first architecture
 * - Strong null safety
 * - Stable API compatibility preserved
 * - soft_deleted filter aligned to partial index predicate (soft_deleted = false)
 */

const { supabase } = require('../../config/supabase');
const cacheManager = require('../../core/cache/cache.manager');
const logger = require('../../utils/logger');

const CACHE_TTL_SECONDS = 600;
const ROLES_CACHE_KEY = 'job-matching:roles';
const ROLES_CACHE_TTL_SECONDS = 1800;

const cache = cacheManager.getClient();

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function normalizeSkillList(raw) {
  if (!Array.isArray(raw)) return [];

  return raw
    .map((item) => {
      if (typeof item === 'string') return item.trim().toLowerCase();
      if (item && typeof item.name === 'string') {
        return item.name.trim().toLowerCase();
      }
      return null;
    })
    .filter(Boolean);
}

function safeNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

// ─────────────────────────────────────────────────────────────
// PROFILE LOADER
// ─────────────────────────────────────────────────────────────

async function loadUserProfile(userId) {
  try {
    const [profileRes, progressRes, userRes] = await Promise.all([
      supabase
        .from('user_profiles')
        .select(`
          id,
          skills,
          target_role,
          current_job_title,
          industry,
          experience_years
        `)
        .eq('id', userId)
        .maybeSingle(),

      supabase
        .from('onboarding_progress')
        .select(`
          id,
          skills,
          target_role,
          industry,
          experience_years
        `)
        .eq('id', userId)
        .maybeSingle(),

      supabase
        .from('users')
        .select(`
          id,
          skills,
          current_job_title,
          industry,
          experience_years
        `)
        .eq('id', userId)
        .maybeSingle()
    ]);

    if (profileRes.error) throw profileRes.error;
    if (progressRes.error) throw progressRes.error;
    if (userRes.error) throw userRes.error;

    const profile = profileRes.data || {};
    const progress = progressRes.data || {};
    const user = userRes.data || {};

    const rawSkills =
      profile.skills ||
      user.skills ||
      progress.skills ||
      [];

    return {
      skills: normalizeSkillList(rawSkills),
      skillsOriginal: Array.isArray(rawSkills) ? rawSkills : [],
      targetRole:
        profile.target_role ||
        profile.current_job_title ||
        user.current_job_title ||
        progress.target_role ||
        null,
      industry: String(
        profile.industry ||
          user.industry ||
          progress.industry ||
          ''
      ).toLowerCase(),
      yearsExperience: safeNumber(
        profile.experience_years ??
          user.experience_years ??
          progress.experience_years,
        0
      )
    };
  } catch (error) {
    logger.error('[JobMatching] Failed to load user profile', {
      userId,
      error: error.message
    });

    return {
      skills: [],
      skillsOriginal: [],
      targetRole: null,
      industry: '',
      yearsExperience: 0
    };
  }
}

// ─────────────────────────────────────────────────────────────
// ROLE FETCHER (JOIN-BASED SUPABASE OPTIMIZED)
// ─────────────────────────────────────────────────────────────

async function fetchRolesWithSkills() {
  try {
    const cached = await cache.get(ROLES_CACHE_KEY);
    if (cached) return JSON.parse(cached);
  } catch (error) {
    logger.warn('[JobMatching] Roles cache read failed', {
      error: error.message
    });
  }

  try {
    const { data, error } = await supabase
      .from('roles')
      .select(`
        id,
        title,
        name,
        sector,
        category,
        experience_years,
        role_skills (
          skill_name
        )
      `)
      // FIX: Changed from .neq('soft_deleted', true) to .eq('soft_deleted', false)
      // Reason: The existing partial indexes on roles use WHERE (soft_deleted = false)
      // as their predicate. Using .eq('soft_deleted', false) ensures PostgreSQL's query
      // planner recognises the predicate match and uses the partial index (idx_roles_active_only,
      // idx_roles_active, etc.) instead of falling back to a sequential scan.
      // Additionally, .neq('soft_deleted', true) would incorrectly include NULL rows,
      // which are not valid active roles and not covered by the partial indexes.
      .eq('soft_deleted', false)
      .limit(500);

    if (error) throw error;

    const roles = (data || []).map((role) => ({
      id: role.id,
      title: role.title || role.name || 'Untitled Role',
      sector: role.sector || role.category || null,
      requiredSkills: Array.isArray(role.role_skills)
        ? role.role_skills
            .map((s) => s.skill_name)
            .filter(Boolean)
            .map((s) => s.toLowerCase())
        : [],
      experienceYears: safeNumber(role.experience_years, 0)
    }));

    try {
      await cache.set(
        ROLES_CACHE_KEY,
        JSON.stringify(roles),
        'EX',
        ROLES_CACHE_TTL_SECONDS
      );
    } catch (cacheError) {
      logger.warn('[JobMatching] Roles cache write failed', {
        error: cacheError.message
      });
    }

    return roles;
  } catch (error) {
    logger.error('[JobMatching] Failed to fetch roles', {
      error: error.message
    });
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// SCORING LOGIC (BUSINESS LOGIC PRESERVED)
// ─────────────────────────────────────────────────────────────

function scoreRole(user, role) {
  let score = 0;

  const userSkills = new Set(user.skills);
  let matched = 0;

  for (const skill of role.requiredSkills) {
    if (userSkills.has(skill)) matched++;
  }

  const skillScore =
    role.requiredSkills.length > 0
      ? (matched / role.requiredSkills.length) * 100
      : 0;

  score += skillScore * 0.6;

  const expDiff = Math.abs(
    safeNumber(user.yearsExperience) -
      safeNumber(role.experienceYears)
  );

  const expScore = Math.max(0, 100 - expDiff * 10);
  score += expScore * 0.2;

  if (
    user.targetRole &&
    role.title &&
    role.title.toLowerCase().includes(user.targetRole.toLowerCase())
  ) {
    score += 20;
  }

  return Math.min(100, Math.round(score * 100) / 100);
}

// ─────────────────────────────────────────────────────────────
// MAIN MATCHING FUNCTION
// ─────────────────────────────────────────────────────────────

async function getJobMatches(userId) {
  const cacheKey = `job-match:${userId}`;

  try {
    const cached = await cache.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch (error) {
    logger.warn('[JobMatching] Match cache read failed', {
      userId,
      error: error.message
    });
  }

  const [user, roles] = await Promise.all([
    loadUserProfile(userId),
    fetchRolesWithSkills()
  ]);

  const sorted = roles
    .map((role) => ({
      role,
      score: scoreRole(user, role)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  try {
    await cache.set(
      cacheKey,
      JSON.stringify(sorted),
      'EX',
      CACHE_TTL_SECONDS
    );
  } catch (error) {
    logger.warn('[JobMatching] Match cache write failed', {
      userId,
      error: error.message
    });
  }

  return sorted;
}

// ─────────────────────────────────────────────────────────────
// RECOMMENDATIONS
// ─────────────────────────────────────────────────────────────

async function getRecommendations(userId) {
  const matches = await getJobMatches(userId);

  return matches.map((match) => ({
    roleId: match.role.id,
    title: match.role.title,
    score: match.score
  }));
}

// ─────────────────────────────────────────────────────────────
// CACHE INVALIDATION
// ─────────────────────────────────────────────────────────────

async function invalidateUserMatchCache(userId) {
  try {
    await cache.del(`job-match:${userId}`);
  } catch (error) {
    logger.warn('[JobMatching] Cache invalidation failed', {
      userId,
      error: error.message
    });
  }
}

module.exports = {
  getJobMatches,
  getRecommendations,
  invalidateUserMatchCache
};