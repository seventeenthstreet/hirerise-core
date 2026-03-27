'use strict';

/**
 * jobApplications.repository.js
 *
 * All Supabase operations for the jobApplications collection.
 * No business logic — pure data access.
 *
 * COLLECTION: jobApplications
 *
 * CHANGES (hardening):
 *   CHANGE 4 — Soft delete: remove() sets deleted:true + deletedAt instead of physical delete
 *              listByUser() filters where deleted != true
 *              update() blocks editing deleted documents
 *   CHANGE 5 — Added optional source field to create() and VALID_SOURCES constant
 *
 * INDEXES REQUIRED (Supabase / Postgres):
 *   1. (userId, deleted, createdAt DESC)   — GET /applications (list)
 *   2. (userId, status, createdAt DESC)    — future status filter
 */
const { supabase } = require('../../config/supabase');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const logger = require('../../utils/logger');

const COLLECTION = 'jobApplications';

// ─── Valid statuses ───────────────────────────────────────────────────────────

const VALID_STATUSES = [
  'applied',
  'rejected',
  'interview_scheduled',
  'interview_completed',
  'offer_received',
  'offer_accepted',
  'offer_rejected',
  'no_response',
  'withdrawn'
];

// CHANGE 5 — Valid source options
const VALID_SOURCES = ['LinkedIn', 'Indeed', 'Referral', 'Company Website', 'Other'];

// ─── Create ───────────────────────────────────────────────────────────────────

async function create(userId, payload) {
  const now = new Date().toISOString();
  const doc = {
    userId,
    companyName: payload.companyName,
    jobTitle: payload.jobTitle,
    emailSentTo: payload.emailSentTo,
    appliedDate: payload.appliedDate ? new Date(payload.appliedDate).toISOString() : now,
    status: payload.status ?? 'applied',
    notes: payload.notes ?? null,
    followUpDate: payload.followUpDate ? new Date(payload.followUpDate).toISOString() : null,
    source: payload.source ?? null, // ← CHANGE 5: optional source field
    deleted: false,                  // ← CHANGE 4: soft delete flag on creation
    createdAt: now,
    updatedAt: now
  };

  const { data, error } = await supabase
    .from(COLLECTION)
    .insert(doc)
    .select('id')
    .single();

  if (error) {
    throw new AppError(`Failed to create job application: ${error.message}`, 500, {}, ErrorCodes.INTERNAL_ERROR);
  }

  logger.debug('[JobAppRepo] Created', { userId, docId: data.id });
  return data.id;
}

// ─── Count (for free tier cap — excludes soft-deleted) ───────────────────────

async function countByUser(userId) {
  // CHANGE 4: only count non-deleted documents against the free tier cap
  const { count, error } = await supabase
    .from(COLLECTION)
    .select('*', { count: 'exact', head: true })
    .eq('userId', userId)
    .eq('deleted', false);

  if (error) {
    throw new AppError(`Failed to count job applications: ${error.message}`, 500, {}, ErrorCodes.INTERNAL_ERROR);
  }

  return count ?? 0;
}

// ─── List with pagination ─────────────────────────────────────────────────────

async function listByUser(userId, { limit = 20, cursor = null, status = null } = {}) {
  const safeLimit = Math.min(Math.max(1, limit), 50);

  // CHANGE 4: filter out soft-deleted documents
  let query = supabase
    .from(COLLECTION)
    .select('*')
    .eq('userId', userId)
    .eq('deleted', false) // ← CHANGE 4
    .order('createdAt', { ascending: false })
    .limit(safeLimit + 1);

  if (status && VALID_STATUSES.includes(status)) {
    query = query.eq('status', status);
  }

  if (cursor) {
    // Fetch the cursor row's createdAt for keyset pagination
    const { data: cursorRow, error: cursorError } = await supabase
      .from(COLLECTION)
      .select('createdAt')
      .eq('id', cursor)
      .maybeSingle();

    if (!cursorError && cursorRow) {
      query = query.lt('createdAt', cursorRow.createdAt);
    }
  }

  const { data, error } = await query;

  if (error) {
    throw new AppError(`Failed to list job applications: ${error.message}`, 500, {}, ErrorCodes.INTERNAL_ERROR);
  }

  const docs = data || [];
  const hasMore = docs.length > safeLimit;
  const sliced = hasMore ? docs.slice(0, safeLimit) : docs;
  const nextCursor = hasMore ? sliced[sliced.length - 1].id : null;

  const applications = sliced.map(row => ({
    id: row.id,
    ...row,
    appliedDate: row.appliedDate ?? null,
    followUpDate: row.followUpDate ?? null,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
    // Never expose internal soft-delete fields to the API response
    deleted: undefined,
    deletedAt: undefined
  }));

  return { applications, nextCursor, hasMore };
}

// ─── Get one (with ownership + deleted check) ─────────────────────────────────

async function getOne(applicationId, userId) {
  const { data, error } = await supabase
    .from(COLLECTION)
    .select('*')
    .eq('id', applicationId)
    .maybeSingle();

  if (error) {
    throw new AppError(`Failed to fetch job application: ${error.message}`, 500, { applicationId }, ErrorCodes.INTERNAL_ERROR);
  }

  if (!data) {
    throw new AppError('Application not found.', 404, { applicationId }, ErrorCodes.NOT_FOUND);
  }

  if (data.userId !== userId) {
    throw new AppError('Unauthorized.', 403, { applicationId }, ErrorCodes.FORBIDDEN);
  }

  // CHANGE 4: treat soft-deleted docs as not found
  if (data.deleted === true) {
    throw new AppError('Application not found.', 404, { applicationId }, ErrorCodes.NOT_FOUND);
  }

  return { id: applicationId, ...data };
}

// ─── Update ───────────────────────────────────────────────────────────────────

async function update(applicationId, userId, updates) {
  // getOne() now throws 404 for deleted docs — PATCH on deleted doc blocked automatically
  await getOne(applicationId, userId);

  const allowedFields = [
    'status',
    'notes',
    'followUpDate',
    'companyName',
    'jobTitle',
    'emailSentTo',
    'appliedDate',
    'source' // ← CHANGE 5
  ];

  const sanitized = {};
  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      if ((field === 'followUpDate' || field === 'appliedDate') && updates[field]) {
        sanitized[field] = new Date(updates[field]).toISOString();
      } else {
        sanitized[field] = updates[field];
      }
    }
  }

  if (Object.keys(sanitized).length === 0) {
    throw new AppError('No valid fields to update.', 400, {}, ErrorCodes.VALIDATION_ERROR);
  }

  sanitized.updatedAt = new Date().toISOString();

  const { error } = await supabase
    .from(COLLECTION)
    .update(sanitized)
    .eq('id', applicationId);

  if (error) {
    throw new AppError(`Failed to update job application: ${error.message}`, 500, { applicationId }, ErrorCodes.INTERNAL_ERROR);
  }

  logger.debug('[JobAppRepo] Updated', {
    applicationId,
    userId,
    fields: Object.keys(sanitized)
  });

  return getOne(applicationId, userId);
}

// ─── Soft Delete ──────────────────────────────────────────────────────────────
// CHANGE 4: Sets deleted:true + deletedAt instead of physically removing the document.
// Reasons:
//   - Audit trail preserved
//   - Recoverable if user requests restoration
//   - Prevents orphaned references in other collections
//   - Free tier cap correctly excludes soft-deleted docs (countByUser filters them)

async function remove(applicationId, userId) {
  // Verify ownership — getOne also blocks already-deleted docs
  await getOne(applicationId, userId);

  const { error } = await supabase
    .from(COLLECTION)
    .update({
      deleted: true,
      deletedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })
    .eq('id', applicationId);

  if (error) {
    throw new AppError(`Failed to delete job application: ${error.message}`, 500, { applicationId }, ErrorCodes.INTERNAL_ERROR);
  }

  logger.debug('[JobAppRepo] Soft deleted', { applicationId, userId });
  return true;
}

module.exports = {
  create,
  countByUser,
  listByUser,
  getOne,
  update,
  remove,
  VALID_STATUSES,
  VALID_SOURCES // ← CHANGE 5: exported for routes schema
};