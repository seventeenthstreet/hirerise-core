'use strict';

/**
 * jobApplications.repository.js (FINAL - SUPABASE OPTIMIZED)
 *
 * - Uses snake_case for DB
 * - Returns camelCase for API
 * - Optimized cursor pagination
 * - Soft delete enabled
 */

const { supabase } = require('../../config/supabase');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const logger = require('../../utils/logger');

const TABLE = 'job_applications';

// ─────────────────────────────────────────────
// 🔹 CONSTANTS
// ─────────────────────────────────────────────

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

const VALID_SOURCES = [
  'LinkedIn',
  'Indeed',
  'Referral',
  'Company Website',
  'Other'
];

// ─────────────────────────────────────────────
// 🔹 MAPPER (DB → API)
// ─────────────────────────────────────────────

function mapToApi(row) {
  return {
    id: row.id,
    companyName: row.company_name,
    jobTitle: row.job_title,
    emailSentTo: row.email_sent_to,
    status: row.status,
    notes: row.notes,
    appliedDate: row.applied_date,
    followUpDate: row.follow_up_date,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// ─────────────────────────────────────────────
// 🔹 CREATE
// ─────────────────────────────────────────────

async function create(userId, payload) {
  const now = new Date().toISOString();

  const doc = {
    user_id: userId,
    company_name: payload.companyName,
    job_title: payload.jobTitle,
    email_sent_to: payload.emailSentTo || null,
    applied_date: payload.appliedDate
      ? new Date(payload.appliedDate).toISOString()
      : now,
    status: VALID_STATUSES.includes(payload.status)
      ? payload.status
      : 'applied',
    notes: payload.notes || null,
    follow_up_date: payload.followUpDate
      ? new Date(payload.followUpDate).toISOString()
      : null,
    source: VALID_SOURCES.includes(payload.source)
      ? payload.source
      : null,
    deleted: false,
    created_at: now,
    updated_at: now
  };

  const { data, error } = await supabase
    .from(TABLE)
    .insert(doc)
    .select('id')
    .single();

  if (error) {
    throw new AppError(
      `Failed to create application: ${error.message}`,
      500,
      {},
      ErrorCodes.INTERNAL_ERROR
    );
  }

  logger.debug('[JobAppRepo] Created', { userId, id: data.id });

  return data.id;
}

// ─────────────────────────────────────────────
// 🔹 COUNT
// ─────────────────────────────────────────────

async function countByUser(userId) {
  const { count, error } = await supabase
    .from(TABLE)
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('deleted', false);

  if (error) {
    throw new AppError(
      `Failed to count applications: ${error.message}`,
      500,
      {},
      ErrorCodes.INTERNAL_ERROR
    );
  }

  return count ?? 0;
}

// ─────────────────────────────────────────────
// 🔹 LIST (OPTIMIZED PAGINATION)
// ─────────────────────────────────────────────

async function listByUser(userId, { limit = 20, cursor = null, status = null } = {}) {
  const safeLimit = Math.min(Math.max(1, limit), 50);

  let query = supabase
    .from(TABLE)
    .select('*')
    .eq('user_id', userId)
    .eq('deleted', false)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(safeLimit + 1);

  if (status && VALID_STATUSES.includes(status)) {
    query = query.eq('status', status);
  }

  // 🔥 Composite cursor
  if (cursor) {
    const [createdAt, id] = cursor.split('|');

    if (createdAt && id) {
      query = query.or(
        `created_at.lt.${createdAt},and(created_at.eq.${createdAt},id.lt.${id})`
      );
    }
  }

  const { data, error } = await query;

  if (error) {
    throw new AppError(
      `Failed to list applications: ${error.message}`,
      500,
      {},
      ErrorCodes.INTERNAL_ERROR
    );
  }

  const rows = data || [];
  const hasMore = rows.length > safeLimit;
  const sliced = hasMore ? rows.slice(0, safeLimit) : rows;

  const nextCursor = hasMore
    ? `${sliced[sliced.length - 1].created_at}|${sliced[sliced.length - 1].id}`
    : null;

  return {
    applications: sliced.map(mapToApi),
    nextCursor,
    hasMore
  };
}

// ─────────────────────────────────────────────
// 🔹 GET ONE
// ─────────────────────────────────────────────

async function getOne(applicationId, userId) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('id', applicationId)
    .maybeSingle();

  if (error) {
    throw new AppError(
      `Failed to fetch application: ${error.message}`,
      500,
      { applicationId },
      ErrorCodes.INTERNAL_ERROR
    );
  }

  if (!data || data.deleted) {
    throw new AppError('Application not found.', 404, {}, ErrorCodes.NOT_FOUND);
  }

  if (data.user_id !== userId) {
    throw new AppError('Unauthorized.', 403, {}, ErrorCodes.FORBIDDEN);
  }

  return mapToApi(data);
}

// ─────────────────────────────────────────────
// 🔹 UPDATE
// ─────────────────────────────────────────────

async function update(applicationId, userId, updates) {
  await getOne(applicationId, userId);

  const sanitized = {};

  if (updates.companyName !== undefined) sanitized.company_name = updates.companyName;
  if (updates.jobTitle !== undefined) sanitized.job_title = updates.jobTitle;
  if (updates.emailSentTo !== undefined) sanitized.email_sent_to = updates.emailSentTo;
  if (updates.notes !== undefined) sanitized.notes = updates.notes;

  if (updates.status && VALID_STATUSES.includes(updates.status)) {
    sanitized.status = updates.status;
  }

  if (updates.source && VALID_SOURCES.includes(updates.source)) {
    sanitized.source = updates.source;
  }

  if (updates.appliedDate) {
    sanitized.applied_date = new Date(updates.appliedDate).toISOString();
  }

  if (updates.followUpDate) {
    sanitized.follow_up_date = new Date(updates.followUpDate).toISOString();
  }

  if (Object.keys(sanitized).length === 0) {
    throw new AppError('No valid fields to update.', 400, {}, ErrorCodes.VALIDATION_ERROR);
  }

  sanitized.updated_at = new Date().toISOString();

  const { error } = await supabase
    .from(TABLE)
    .update(sanitized)
    .eq('id', applicationId);

  if (error) {
    throw new AppError(
      `Failed to update application: ${error.message}`,
      500,
      {},
      ErrorCodes.INTERNAL_ERROR
    );
  }

  logger.debug('[JobAppRepo] Updated', { applicationId });

  return getOne(applicationId, userId);
}

// ─────────────────────────────────────────────
// 🔹 DELETE (SOFT)
// ─────────────────────────────────────────────

async function remove(applicationId, userId) {
  await getOne(applicationId, userId);

  const { error } = await supabase
    .from(TABLE)
    .update({
      deleted: true,
      deleted_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('id', applicationId);

  if (error) {
    throw new AppError(
      `Failed to delete application: ${error.message}`,
      500,
      {},
      ErrorCodes.INTERNAL_ERROR
    );
  }

  logger.debug('[JobAppRepo] Soft deleted', { applicationId });

  return true;
}

// ─────────────────────────────────────────────
// 🔹 EXPORTS
// ─────────────────────────────────────────────

module.exports = {
  create,
  countByUser,
  listByUser,
  getOne,
  update,
  remove,
  VALID_STATUSES,
  VALID_SOURCES
};