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
 *   FIX-8d: listJobFamilies now caps results at 200 to prevent unbounded Firestore reads.
 */

'use strict';

const { db }                   = require('../config/firebase');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

const COLLECTIONS = {
  ROLES:        'roles',
  JOB_FAMILIES: 'jobFamilies',
};

const PAGE_SIZE_DEFAULT = 20;
const JOB_FAMILIES_MAX  = 200; // FIX-8d: safety cap on unbounded collection reads

/**
 * FIX-8a: Allowlist-based field filter for public job/role responses.
 * Only fields in this list are returned to API consumers.
 * Internal Firestore housekeeping fields are excluded by default.
 */
const toPublicJob = (doc) => {
  const data = doc.data ? doc.data() : doc; // support both Firestore doc and plain object
  return {
    id:          doc.id || data.id,
    title:       data.title,
    level:       data.level,
    track:       data.track,
    jobFamilyId: data.jobFamilyId,
    description: data.description,
    skills:      data.skills,
    // Add other public fields here as the schema evolves
    // DO NOT spread data — always use an allowlist
  };
};

const toPublicFamily = (doc) => {
  const data = doc.data();
  return {
    id:          doc.id,
    name:        data.name,
    description: data.description,
    trackCount:  data.trackCount,
  };
};

const listJobFamilies = async () => {
  const snap = await db.collection(COLLECTIONS.JOB_FAMILIES)
    .orderBy('name')
    .limit(JOB_FAMILIES_MAX) // FIX-8d: cap results
    .get();

  return snap.docs.map(toPublicFamily); // FIX-8b: strip internal fields
};

const listRoles = async ({ familyId, level, track, limit = PAGE_SIZE_DEFAULT, page = 1 }) => {
  const parsedLimit = Math.min(parseInt(limit, 10) || PAGE_SIZE_DEFAULT, 100); // max 100 per page

  let query = db.collection(COLLECTIONS.ROLES);

  if (familyId) query = query.where('jobFamilyId', '==', familyId);
  if (level)    query = query.where('level',       '==', level);
  if (track)    query = query.where('track',       '==', track);

  query = query.orderBy('title').limit(parsedLimit);

  // Firestore does not support offset-based pagination natively at scale.
  // Phase 2: use cursor-based pagination with startAfter(lastDoc).
  const snap  = await query.get();
  const roles = snap.docs.map(toPublicJob); // FIX-8b: strip internal fields

  return {
    roles,
    page:    parseInt(page, 10),
    limit:   parsedLimit,
    count:   roles.length,
    hasMore: roles.length === parsedLimit, // FIX-8c: lets frontend know if more pages exist
  };
};

const getRoleById = async (roleId) => {
  const snap = await db.collection(COLLECTIONS.ROLES).doc(roleId).get();

  if (!snap.exists) {
    throw new AppError(`Role '${roleId}' not found`, 404, { roleId }, ErrorCodes.ROLE_NOT_FOUND);
  }

  return toPublicJob(snap); // FIX-8b: strip internal fields
};

module.exports = { listJobFamilies, listRoles, getRoleById };
