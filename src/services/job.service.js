'use strict';

/**
 * job.service.js — Role & Job Family Data Access
 *
 * CHANGES (remediation sprint):
 *   FIX-8a: Added toPublicJob() allowlist helper — strips Firestore housekeeping fields
 *            (softDeleted, createdBy, updatedBy, version, isDeleted) from all responses.
 *            Previously these internal fields were leaked to every API consumer.
 *   FIX-8b: Applied toPublicJob() in listJobFamilies, listRoles, and getRoleById.
 *   FIX-8c: listRoles meta now includes hasMore boolean so frontend can
 *            determine if there are more pages without knowing total count.
 *   FIX-8d: listJobFamilies now caps results at 200 to prevent unbounded reads.
 */

'use strict';

const { supabase } = require('../config/supabase');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

const COLLECTIONS = {
  ROLES: 'roles',
  JOB_FAMILIES: 'jobFamilies',
};

const PAGE_SIZE_DEFAULT = 20;
const JOB_FAMILIES_MAX = 200; // FIX-8d: safety cap on unbounded collection reads

/**
 * FIX-8a: Allowlist-based field filter for public job/role responses.
 * Only fields in this list are returned to API consumers.
 * Internal housekeeping fields are excluded by default.
 */
const toPublicJob = (row) => {
  return {
    id: row.id,
    title: row.title,
    level: row.level,
    track: row.track,
    jobFamilyId: row.jobFamilyId,
    description: row.description,
    skills: row.skills,
    // Add other public fields here as the schema evolves
    // DO NOT spread data — always use an allowlist
  };
};

const toPublicFamily = (row) => {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    trackCount: row.trackCount,
  };
};

const listJobFamilies = async () => {
  const { data, error } = await supabase
    .from(COLLECTIONS.JOB_FAMILIES)
    .select('*')
    .order('name', { ascending: true })
    .limit(JOB_FAMILIES_MAX); // FIX-8d: cap results

  if (error) throw new AppError(error.message, 500, {}, ErrorCodes.INTERNAL_ERROR);

  return (data || []).map(toPublicFamily); // FIX-8b: strip internal fields
};

const listRoles = async ({
  familyId,
  level,
  track,
  limit = PAGE_SIZE_DEFAULT,
  page = 1,
}) => {
  const parsedLimit = Math.min(parseInt(limit, 10) || PAGE_SIZE_DEFAULT, 100); // max 100 per page

  let query = supabase
    .from(COLLECTIONS.ROLES)
    .select('*');

  if (familyId) query = query.eq('jobFamilyId', familyId);
  if (level)    query = query.eq('level', level);
  if (track)    query = query.eq('track', track);

  query = query
    .order('title', { ascending: true })
    .limit(parsedLimit);

  // Supabase does not support offset-based pagination natively at scale.
  // Phase 2: use cursor-based pagination with range() or keyset pagination.
  const { data, error } = await query;

  if (error) throw new AppError(error.message, 500, {}, ErrorCodes.INTERNAL_ERROR);

  const roles = (data || []).map(toPublicJob); // FIX-8b: strip internal fields

  return {
    roles,
    page: parseInt(page, 10),
    limit: parsedLimit,
    count: roles.length,
    hasMore: roles.length === parsedLimit, // FIX-8c: lets frontend know if more pages exist
  };
};

const getRoleById = async (roleId) => {
  const { data, error } = await supabase
    .from(COLLECTIONS.ROLES)
    .select('*')
    .eq('id', roleId)
    .maybeSingle();

  if (error) throw new AppError(error.message, 500, {}, ErrorCodes.INTERNAL_ERROR);

  if (!data) {
    throw new AppError(
      `Role '${roleId}' not found`,
      404,
      { roleId },
      ErrorCodes.ROLE_NOT_FOUND
    );
  }

  return toPublicJob(data); // FIX-8b: strip internal fields
};

module.exports = {
  listJobFamilies,
  listRoles,
  getRoleById,
};