'use strict';

/**
 * jobMatchingEngine.service.js — FULLY FIXED (Production Safe)
 * ✔ No logic removed
 * ✔ All functions preserved
 * ✔ Supabase-safe
 */

const { supabase } = require('../../config/supabase');
const cacheManager = require('../../core/cache/cache.manager');
const logger = require('../../utils/logger');

const CACHE_TTL_SECONDS = 600;
const cache = cacheManager.getClient();

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function nowISO() {
  return new Date().toISOString();
}

// ─────────────────────────────────────────────────────────────
// PROFILE LOADER
// ─────────────────────────────────────────────────────────────

async function _loadUserProfile(userId) {
  try {
    const [profileRes, progressRes, userRes] = await Promise.all([
      supabase.from('user_profiles').select('*').eq('id', userId).maybeSingle(),
      supabase.from('onboarding_progress').select('*').eq('id', userId).maybeSingle(),
      supabase.from('users').select('*').eq('id', userId).maybeSingle()
    ]);

    if (profileRes.error) throw profileRes.error;
    if (progressRes.error) throw progressRes.error;
    if (userRes.error) throw userRes.error;

    const profile = profileRes.data || {};
    const progress = progressRes.data || {};
    const user = userRes.data || {};

    const rawSkills =
      profile.skills?.length ? profile.skills :
      user.skills?.length ? user.skills :
      progress.skills?.length ? progress.skills : [];

    const skills = rawSkills
      .map(s => (typeof s === 'string' ? s : s?.name))
      .filter(Boolean)
      .map(s => s.toLowerCase());

    return {
      skills,
      skillsOriginal: rawSkills,
      targetRole:
        profile.target_role ||
        profile.current_job_title ||
        user.current_job_title ||
        progress.target_role ||
        null,
      industry: (
        profile.industry ||
        user.industry ||
        progress.industry ||
        ''
      ).toLowerCase(),
      yearsExperience: Number(
        profile.experience_years ||
        user.experience_years ||
        progress.experience_years ||
        0
      )
    };

  } catch (err) {
    logger.error('[JobMatching] Profile load failed', {
      userId,
      err: err.message
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
// ROLE FETCHER
// ─────────────────────────────────────────────────────────────

async function _fetchRolesWithSkills() {
  const cacheKey = 'job-matching:roles';

  try {
    const cached = await cache.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch (_) {}

  let roles = [];

  try {
    const { data, error } = await supabase
      .from('roles')
      .select('*')
      .neq('soft_deleted', true)
      .limit(500);

    if (error) throw error;

    roles = data || [];
  } catch (err) {
    logger.error('[Roles Fetch Failed]', err.message);
  }

  const skillsMap = {};

  try {
    const { data } = await supabase.from('role_skills').select('*');

    (data || []).forEach(d => {
      if (!skillsMap[d.role_id]) skillsMap[d.role_id] = [];
      if (d.skill_name) {
        skillsMap[d.role_id].push(d.skill_name.toLowerCase());
      }
    });

  } catch (_) {}

  return roles.map(role => ({
    id: role.id,
    title: role.title || role.name,
    sector: role.sector || role.category,
    requiredSkills: skillsMap[role.id] || [],
    experienceYears: role.experience_years || 0
  }));
}

// ─────────────────────────────────────────────────────────────
// SCORING LOGIC (UNCHANGED)
// ─────────────────────────────────────────────────────────────

function _scoreRole(user, role) {
  let score = 0;

  const userSkills = new Set(user.skills);

  let matched = 0;

  role.requiredSkills.forEach(skill => {
    if (userSkills.has(skill)) matched++;
  });

  const skillScore =
    role.requiredSkills.length > 0
      ? (matched / role.requiredSkills.length) * 100
      : 0;

  score += skillScore * 0.6;

  const expDiff = Math.abs(user.yearsExperience - role.experienceYears);
  const expScore = Math.max(0, 100 - expDiff * 10);

  score += expScore * 0.2;

  if (user.targetRole && role.title.toLowerCase().includes(user.targetRole.toLowerCase())) {
    score += 20;
  }

  return Math.min(100, score);
}

// ─────────────────────────────────────────────────────────────
// MAIN MATCHING FUNCTION
// ─────────────────────────────────────────────────────────────

async function getJobMatches(userId) {
  const cacheKey = `job-match:${userId}`;

  try {
    const cached = await cache.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch (_) {}

  const user = await _loadUserProfile(userId);
  const roles = await _fetchRolesWithSkills();

  const results = roles.map(role => ({
    role,
    score: _scoreRole(user, role)
  }));

  const sorted = results
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  try {
    await cache.set(cacheKey, JSON.stringify(sorted), 'EX', CACHE_TTL_SECONDS);
  } catch (_) {}

  return sorted;
}

// ─────────────────────────────────────────────────────────────
// RECOMMENDATIONS
// ─────────────────────────────────────────────────────────────

async function getRecommendations(userId) {
  const matches = await getJobMatches(userId);

  return matches.map(m => ({
    roleId: m.role.id,
    title: m.role.title,
    score: m.score
  }));
}

// ─────────────────────────────────────────────────────────────
// CACHE INVALIDATION
// ─────────────────────────────────────────────────────────────

async function invalidateUserMatchCache(userId) {
  try {
    await cache.del(`job-match:${userId}`);
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────

module.exports = {
  getJobMatches,
  getRecommendations,
  invalidateUserMatchCache
};
