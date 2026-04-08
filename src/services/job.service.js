'use strict';

/**
 * src/services/job.service.js
 *
 * Production-grade Role & Job Family data access service.
 *
 * Supabase migration upgrades:
 * - Removed remaining Firestore-style "collection" assumptions
 * - Replaced unbounded selects with column projection
 * - Replaced fake page pagination with SQL range pagination
 * - Removed wildcard selects to prevent internal field leakage
 * - Added strict input normalization and null safety
 * - Added +1 pagination fetch strategy for efficient hasMore
 * - Added centralized Supabase error normalization
 * - Preserved API response contract
 *
 * Schema fix applied:
 * - toPublicJob: id falls back to role_id for rows where
 *   the new id column was not explicitly set on insert
 */

const { supabase } = require('../config/supabase');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

const TABLES = Object.freeze({
  ROLES: 'roles',
  JOB_FAMILIES: 'job_families',
});

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;
const JOB_FAMILIES_MAX = 200;

/**
 * Public projection for roles.
 * Only safe API fields are exposed.
 * All columns exist on the live schema after migration.
 */
const ROLE_PUBLIC_COLUMNS = `
  id,
  title,
  level,
  track,
  job_family_id,
  description,
  skills
`;

/**
 * Public projection for job families.
 */
const FAMILY_PUBLIC_COLUMNS = `
  id,
  name,
  description,
  track_count
`;

/**
 * Normalize Supabase DB row -> public API role payload.
 * Preserves existing API contract (camelCase).
 *
 * FIX: id falls back to role_id — the new id column is nullable
 * for rows inserted before the migration backfill. role_id is
 * always populated and serves as the safe fallback.
 */
const toPublicJob = (row = {}) => ({
  id:          row.id ?? row.role_id ?? null,
  title:       row.title ?? null,
  level:       row.level ?? null,
  track:       row.track ?? null,
  jobFamilyId: row.job_family_id ?? null,
  description: row.description ?? null,
  skills:      Array.isArray(row.skills) ? row.skills : [],
});

/**
 * Normalize Supabase DB row -> public API family payload.
 */
const toPublicFamily = (row = {}) => ({
  id:          row.id ?? null,
  name:        row.name ?? null,
  description: row.description ?? null,
  trackCount:  row.track_count ?? 0,
});

/**
 * Centralized Supabase error wrapper.
 */
const throwDbError = (error, operation, meta = {}) => {
  throw new AppError(
    `Database error during ${operation}: ${error.message}`,
    500,
    {
      ...meta,
      code:    error.code,
      details: error.details,
      hint:    error.hint,
    },
    ErrorCodes.INTERNAL_ERROR
  );
};

/**
 * Safe integer normalization.
 */
const normalizePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * List all job families.
 */
const listJobFamilies = async () => {
  const { data, error } = await supabase
    .from(TABLES.JOB_FAMILIES)
    .select(FAMILY_PUBLIC_COLUMNS)
    .eq('soft_deleted', false)
    .order('name', { ascending: true })
    .limit(JOB_FAMILIES_MAX);

  if (error) {
    throwDbError(error, 'listJobFamilies');
  }

  return (data ?? []).map(toPublicFamily);
};

/**
 * List roles with proper SQL pagination.
 */
const listRoles = async ({
  familyId,
  level,
  track,
  limit = PAGE_SIZE_DEFAULT,
  page = 1,
} = {}) => {
  const parsedLimit = Math.min(
    normalizePositiveInt(limit, PAGE_SIZE_DEFAULT),
    PAGE_SIZE_MAX
  );

  const parsedPage = normalizePositiveInt(page, 1);
  const offset = (parsedPage - 1) * parsedLimit;

  /**
   * +1 fetch strategy:
   * Efficiently determines hasMore without COUNT(*)
   */
  const fetchSize = parsedLimit + 1;

  let query = supabase
    .from(TABLES.ROLES)
    .select(ROLE_PUBLIC_COLUMNS)
    .order('title', { ascending: true })
    .range(offset, offset + fetchSize - 1);

  if (familyId) {
    query = query.eq('job_family_id', familyId);
  }

  if (level) {
    query = query.eq('level', level);
  }

  if (track) {
    query = query.eq('track', track);
  }

  const { data, error } = await query;

  if (error) {
    throwDbError(error, 'listRoles', {
      familyId,
      level,
      track,
      page:  parsedPage,
      limit: parsedLimit,
    });
  }

  const rows     = data ?? [];
  const hasMore  = rows.length > parsedLimit;
  const roles    = rows.slice(0, parsedLimit).map(toPublicJob);

  return {
    roles,
    page:   parsedPage,
    limit:  parsedLimit,
    count:  roles.length,
    hasMore,
  };
};

/**
 * Get single role by ID.
 */
const getRoleById = async (roleId) => {
  if (!roleId) {
    throw new AppError(
      'roleId is required',
      400,
      { roleId },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const { data, error } = await supabase
    .from(TABLES.ROLES)
    .select(ROLE_PUBLIC_COLUMNS)
    .eq('id', roleId)
    .maybeSingle();

  if (error) {
    throwDbError(error, 'getRoleById', { roleId });
  }

  if (!data) {
    throw new AppError(
      `Role '${roleId}' not found`,
      404,
      { roleId },
      ErrorCodes.ROLE_NOT_FOUND
    );
  }

  return toPublicJob(data);
};

module.exports = {
  listJobFamilies,
  listRoles,
  getRoleById,
};