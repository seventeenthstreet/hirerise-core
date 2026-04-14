'use strict';

const { supabase } = require('../config/supabase');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

const TABLES = Object.freeze({
  ROLES: 'roles',
  JOB_FAMILIES: 'job_families',
});

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;
const JOB_FAMILIES_MAX = 200;

const QUERY_CACHE_TTL_MS = 60000;
const queryMicroCache = new Map();
const inflightQueries = new Map();

const ROLE_PUBLIC_COLUMNS = `
  id,
  title,
  level,
  track,
  job_family_id,
  description,
  skills
`;

const FAMILY_PUBLIC_COLUMNS = `
  id,
  name,
  description,
  track_count
`;

const toPublicJob = (row = {}) => ({
  id: row.id ?? row.role_id ?? null,
  title: row.title ?? null,
  level: row.level ?? null,
  track: row.track ?? null,
  jobFamilyId: row.job_family_id ?? null,
  description: row.description ?? null,
  skills: Array.isArray(row.skills) ? row.skills : [],
});

const toPublicFamily = (row = {}) => ({
  id: row.id ?? null,
  name: row.name ?? null,
  description: row.description ?? null,
  trackCount: row.track_count ?? 0,
});

const throwDbError = (error, operation, meta = {}) => {
  throw new AppError(
    `Database error during ${operation}: ${error.message}`,
    500,
    {
      ...meta,
      code: error.code,
      details: error.details,
      hint: error.hint,
    },
    ErrorCodes.INTERNAL_ERROR
  );
};

const normalizePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

function getCached(key) {
  const cached = queryMicroCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    queryMicroCache.delete(key);
    return null;
  }
  return cached.value;
}

function setCached(key, value) {
  queryMicroCache.set(key, {
    value,
    expiresAt: Date.now() + QUERY_CACHE_TTL_MS,
  });
}

async function withQueryDedupe(key, factory) {
  const cached = getCached(key);
  if (cached) return cached;

  if (inflightQueries.has(key)) {
    return inflightQueries.get(key);
  }

  const promise = (async () => {
    const result = await factory();
    setCached(key, result);
    return result;
  })();

  inflightQueries.set(key, promise);

  try {
    return await promise;
  } finally {
    inflightQueries.delete(key);
  }
}

const listJobFamilies = async () => {
  return withQueryDedupe('job-families', async () => {
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
  });
};

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
  const fetchSize = parsedLimit + 1;

  const cacheKey = JSON.stringify({
    familyId,
    level,
    track,
    limit: parsedLimit,
    page: parsedPage,
  });

  return withQueryDedupe(cacheKey, async () => {
    let query = supabase
      .from(TABLES.ROLES)
      .select(ROLE_PUBLIC_COLUMNS)
      .order('title', { ascending: true })
      .range(offset, offset + fetchSize - 1);

    if (familyId) query = query.eq('job_family_id', familyId);
    if (level) query = query.eq('level', level);
    if (track) query = query.eq('track', track);

    const { data, error } = await query;

    if (error) {
      throwDbError(error, 'listRoles', {
        familyId,
        level,
        track,
        page: parsedPage,
        limit: parsedLimit,
      });
    }

    const rows = data ?? [];
    const hasMore = rows.length > parsedLimit;
    const roles = rows.slice(0, parsedLimit).map(toPublicJob);

    return {
      roles,
      page: parsedPage,
      limit: parsedLimit,
      count: roles.length,
      hasMore,
    };
  });
};

const getRoleById = async (roleId) => {
  if (!roleId) {
    throw new AppError(
      'roleId is required',
      400,
      { roleId },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  return withQueryDedupe(`role:${roleId}`, async () => {
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
  });
};

module.exports = {
  listJobFamilies,
  listRoles,
  getRoleById,
};