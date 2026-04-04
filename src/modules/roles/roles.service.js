'use strict';

/**
 * src/modules/roles/roles.service.js
 *
 * Final production-safe Supabase service.
 */

const { supabase } = require('../../config/supabase');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const logger = require('../../utils/logger');

const {
  EXPECTED_ROLE_LIMITS,
  FREE_EXPECTED_LIMIT,
  MAX_PREVIOUS_ROLES,
  DEFAULT_SEARCH_LIMIT,
} = require('./roles.types');

const ROLES_TABLE = 'roles';
const PROFILES_TABLE = 'user_profiles';
const ONBOARDING_TABLE = 'onboarding_progress';

function nowISO() {
  return new Date().toISOString();
}

function getExpectedRoleLimit(plan) {
  return EXPECTED_ROLE_LIMITS[plan] ?? FREE_EXPECTED_LIMIT;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function mapRole(row) {
  return {
    id: row.role_id,
    title: row.role_name,
    category: row.role_family,
    aliases: row.alternative_titles || [],
    seniorityLevel: row.seniority_level || null,
    active: !row.soft_deleted,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function validateRolesExist(roleIds = []) {
  const uniqueIds = [...new Set(normalizeArray(roleIds))];
  if (!uniqueIds.length) return new Map();

  const { data, error } = await supabase
    .from(ROLES_TABLE)
    .select(
      'role_id, role_name, role_family, alternative_titles, seniority_level, soft_deleted, created_at, updated_at'
    )
    .in('role_id', uniqueIds)
    .eq('soft_deleted', false);

  if (error) {
    logger.error('Role validation query failed', { error, roleIds: uniqueIds });
    throw error;
  }

  const foundIds = new Set((data || []).map((r) => r.role_id));
  const invalidIds = uniqueIds.filter((id) => !foundIds.has(id));

  if (invalidIds.length) {
    throw new AppError(
      'Invalid role IDs',
      400,
      { invalidIds },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  return new Map((data || []).map((r) => [r.role_id, mapRole(r)]));
}

async function listRoles({
  search,
  category,
  limit = DEFAULT_SEARCH_LIMIT,
} = {}) {
  const safeLimit = Math.min(Number(limit) || DEFAULT_SEARCH_LIMIT, 100);

  let query = supabase
    .from(ROLES_TABLE)
    .select(
      'role_id, role_name, role_family, alternative_titles, seniority_level, soft_deleted, created_at, updated_at',
      { count: 'exact' }
    )
    .eq('soft_deleted', false)
    .limit(safeLimit);

  if (category) {
    query = query.eq('role_family', category);
  }

  if (search?.trim()) {
    const term = `%${search.trim()}%`;
    query = query.or(`role_name.ilike.${term}`);
  }

  const { data, error, count } = await query;

  if (error) {
    logger.error('Role list query failed', { error, search, category });
    throw error;
  }

  const roles = (data || []).map(mapRole);

  return {
    roles,
    total: count ?? roles.length,
  };
}

async function getRoleById(roleId) {
  const { data, error } = await supabase
    .from(ROLES_TABLE)
    .select(
      'role_id, role_name, role_family, alternative_titles, seniority_level, soft_deleted, created_at, updated_at'
    )
    .eq('role_id', roleId)
    .eq('soft_deleted', false)
    .maybeSingle();

  if (error) {
    logger.error('Get role by ID failed', { error, roleId });
    throw error;
  }

  if (!data) {
    throw new AppError('Role not found', 404);
  }

  return mapRole(data);
}

async function saveOnboardingRoles(userId, plan, payload = {}) {
  const currentRoleId = payload.currentRoleId;
  const previousRoleIds = normalizeArray(payload.previousRoleIds);
  const expectedRoleIds = normalizeArray(payload.expectedRoleIds);

  const expectedLimit = getExpectedRoleLimit(plan);

  if (!currentRoleId) {
    throw new AppError(
      'Current role is required',
      400,
      {},
      ErrorCodes.VALIDATION_ERROR
    );
  }

  if (previousRoleIds.length > MAX_PREVIOUS_ROLES) {
    throw new AppError(
      `Maximum ${MAX_PREVIOUS_ROLES} previous roles allowed`,
      400,
      {},
      ErrorCodes.VALIDATION_ERROR
    );
  }

  if (expectedRoleIds.length > expectedLimit) {
    throw new AppError(
      'Quota exceeded',
      403,
      { allowed: expectedLimit },
      ErrorCodes.FORBIDDEN
    );
  }

  await validateRolesExist([
    currentRoleId,
    ...previousRoleIds,
    ...expectedRoleIds,
  ]);

  const now = nowISO();

  const { error: profileError } = await supabase
    .from(PROFILES_TABLE)
    .upsert({
      id: userId,
      current_role_id: currentRoleId,
      previous_role_ids: previousRoleIds,
      expected_role_ids: expectedRoleIds,
      updated_at: now,
    }, { onConflict: 'id' });

  if (profileError) throw profileError;

  const { error: onboardingError } = await supabase
    .from(ONBOARDING_TABLE)
    .upsert({
      id: userId,
      step: 'roles_saved',
      updated_at: now,
    }, { onConflict: 'id' });

  if (onboardingError) throw onboardingError;

  logger.info('Roles onboarding saved', { userId });

  return {
    userId,
    step: 'roles_saved',
  };
}

async function getUserProfile(userId) {
  const { data, error } = await supabase
    .from(PROFILES_TABLE)
    .select(
      'id, current_role_id, previous_role_ids, expected_role_ids, updated_at'
    )
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    logger.error('Get user profile failed', { error, userId });
    throw error;
  }

  return data || null;
}

module.exports = {
  listRoles,
  getRoleById,
  saveOnboardingRoles,
  getUserProfile,
  validateRolesExist,
  getExpectedRoleLimit,
};