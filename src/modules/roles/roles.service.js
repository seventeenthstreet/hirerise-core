'use strict';

/**
 * roles.service.js — FULLY FIXED (Supabase Production Safe)
 */

const { supabase } = require('../../config/supabase');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const logger = require('../../utils/logger');

const {
  EXPECTED_ROLE_LIMITS,
  FREE_EXPECTED_LIMIT,
  MAX_PREVIOUS_ROLES,
  DEFAULT_SEARCH_LIMIT
} = require('./roles.types');

const ROLES_TABLE = 'roles';
const CMS_ROLES_TABLE = 'cms_roles';
const PROFILES_TABLE = 'user_profiles';
const ONBOARDING_TABLE = 'onboarding_progress';

// ─────────────────────────────────────────────────────────────

function nowISO() {
  return new Date().toISOString();
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function getExpectedRoleLimit(plan) {
  return EXPECTED_ROLE_LIMITS[plan] ?? FREE_EXPECTED_LIMIT;
}

// ─────────────────────────────────────────────────────────────
// VALIDATE ROLES (OPTIMIZED)
// ─────────────────────────────────────────────────────────────

async function validateRolesExist(roleIds) {
  if (!roleIds?.length) return new Map();

  const uniqueIds = [...new Set(roleIds)];

  // ✅ FIX: single query instead of N queries
  const { data: roles, error } = await supabase
    .from(ROLES_TABLE)
    .select('*')
    .in('id', uniqueIds);

  if (error) throw error;

  const roleMap = new Map();
  const foundIds = new Set((roles || []).map(r => r.id));

  const invalidIds = uniqueIds.filter(id => !foundIds.has(id));

  if (invalidIds.length) {
    throw new AppError('Invalid role IDs', 400, { invalidIds }, ErrorCodes.VALIDATION_ERROR);
  }

  roles.forEach(r => roleMap.set(r.id, r));
  return roleMap;
}

// ─────────────────────────────────────────────────────────────
// LIST ROLES
// ─────────────────────────────────────────────────────────────

async function listRoles({ search, category, limit = DEFAULT_SEARCH_LIMIT } = {}) {

  let query = supabase
    .from(ROLES_TABLE)
    .select('*')
    .eq('active', true)
    .limit(limit * (search ? 5 : 1));

  if (category) query = query.eq('category', category);

  const { data, error } = await query;
  if (error) throw error;

  let roles = (data || []).map(row => ({
    id: row.id,
    title: row.title,
    category: row.category,
    aliases: row.aliases || [],
    skillTags: row.skill_tags || [],
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));

  if (search) {
    const term = search.toLowerCase();
    roles = roles.filter(r =>
      r.title.toLowerCase().includes(term) ||
      r.aliases.some(a => a.toLowerCase().includes(term))
    );
  }

  return { roles: roles.slice(0, limit), total: roles.length };
}

// ─────────────────────────────────────────────────────────────
// GET ROLE
// ─────────────────────────────────────────────────────────────

async function getRoleById(roleId) {
  const { data, error } = await supabase
    .from(ROLES_TABLE)
    .select('*')
    .eq('id', roleId)
    .maybeSingle();

  if (error) throw error;
  if (!data || data.active === false) {
    throw new AppError('Role not found', 404);
  }

  return {
    id: data.id,
    title: data.title,
    category: data.category,
    aliases: data.aliases || [],
    skillTags: data.skill_tags || [],
    createdAt: data.created_at
  };
}

// ─────────────────────────────────────────────────────────────
// SAVE ONBOARDING ROLES
// ─────────────────────────────────────────────────────────────

async function saveOnboardingRoles(userId, plan, payload) {

  const {
    currentRoleId,
    previousRoleIds = [],
    expectedRoleIds = []
  } = payload;

  const limit = getExpectedRoleLimit(plan);

  if (expectedRoleIds.length > limit) {
    throw new AppError('Quota exceeded', 403);
  }

  await validateRolesExist([
    currentRoleId,
    ...previousRoleIds,
    ...expectedRoleIds
  ]);

  const now = nowISO();

  const profileData = {
    id: userId,
    current_role_id: currentRoleId,
    previous_role_ids: previousRoleIds,
    expected_role_ids: expectedRoleIds,
    updated_at: now
  };

  const { error: pErr } = await supabase
    .from(PROFILES_TABLE)
    .upsert(profileData, { onConflict: 'id' });

  if (pErr) throw pErr;

  const { error: oErr } = await supabase
    .from(ONBOARDING_TABLE)
    .upsert({
      id: userId,
      step: 'roles_saved',
      updated_at: now
    }, { onConflict: 'id' });

  if (oErr) throw oErr;

  return {
    userId,
    step: 'roles_saved'
  };
}

// ─────────────────────────────────────────────────────────────

async function getUserProfile(userId) {
  const { data, error } = await supabase
    .from(PROFILES_TABLE)
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

// ─────────────────────────────────────────────────────────────

module.exports = {
  listRoles,
  getRoleById,
  saveOnboardingRoles,
  getUserProfile,
  validateRolesExist,
  getExpectedRoleLimit
};
