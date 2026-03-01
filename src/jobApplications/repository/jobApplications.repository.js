'use strict';

/**
 * jobApplications.repository.js
 *
 * All Firestore operations for the jobApplications collection.
 * No business logic — pure data access.
 *
 * COLLECTION: jobApplications/{auto-id}
 *
 * CHANGES (hardening):
 *   CHANGE 4 — Soft delete: remove() sets deleted:true + deletedAt instead of .delete()
 *              listByUser() filters where deleted != true
 *              update() blocks editing deleted documents
 *   CHANGE 5 — Added optional source field to create() and VALID_SOURCES constant
 *
 * INDEXES REQUIRED (add to firestore.indexes.json):
 *   1. [userId ASC, deleted ASC, createdAt DESC]   — GET /applications (list)
 *   2. [userId ASC, status ASC, createdAt DESC]    — future status filter
 */

const { db, admin }            = require('../../../config/firebase');
const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');
const logger                   = require('../../../utils/logger');

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
  'withdrawn',
];

// CHANGE 5 — Valid source options
const VALID_SOURCES = ['LinkedIn', 'Indeed', 'Referral', 'Company Website', 'Other'];

// ─── Create ───────────────────────────────────────────────────────────────────

async function create(userId, payload) {
  const now = new Date();

  const doc = {
    userId,
    companyName:   payload.companyName,
    jobTitle:      payload.jobTitle,
    emailSentTo:   payload.emailSentTo,
    appliedDate:   payload.appliedDate ? new Date(payload.appliedDate) : now,
    status:        payload.status      ?? 'applied',
    notes:         payload.notes       ?? null,
    followUpDate:  payload.followUpDate ? new Date(payload.followUpDate) : null,
    source:        payload.source      ?? null,   // ← CHANGE 5: optional source field
    deleted:       false,                          // ← CHANGE 4: soft delete flag on creation
    createdAt:     now,
    updatedAt:     now,
  };

  const ref = await db.collection(COLLECTION).add(doc);
  logger.debug('[JobAppRepo] Created', { userId, docId: ref.id });
  return ref.id;
}

// ─── Count (for free tier cap — excludes soft-deleted) ───────────────────────

async function countByUser(userId) {
  // CHANGE 4: only count non-deleted documents against the free tier cap
  const snap = await db
    .collection(COLLECTION)
    .where('userId',  '==', userId)
    .where('deleted', '==', false)
    .get();
  return snap.size;
}

// ─── List with pagination ─────────────────────────────────────────────────────

async function listByUser(userId, { limit = 20, cursor = null, status = null } = {}) {
  const safeLimit = Math.min(Math.max(1, limit), 50);

  // CHANGE 4: filter out soft-deleted documents
  let query = db
    .collection(COLLECTION)
    .where('userId',  '==', userId)
    .where('deleted', '==', false)           // ← CHANGE 4
    .orderBy('createdAt', 'desc')
    .limit(safeLimit + 1);

  if (status && VALID_STATUSES.includes(status)) {
    query = query.where('status', '==', status);
  }

  if (cursor) {
    const cursorDoc = await db.collection(COLLECTION).doc(cursor).get();
    if (cursorDoc.exists) {
      query = query.startAfter(cursorDoc);
    }
  }

  const snap       = await query.get();
  const docs       = snap.docs;
  const hasMore    = docs.length > safeLimit;
  const sliced     = hasMore ? docs.slice(0, safeLimit) : docs;
  const nextCursor = hasMore ? sliced[sliced.length - 1].id : null;

  const applications = sliced.map(doc => ({
    id: doc.id,
    ...doc.data(),
    appliedDate:  doc.data().appliedDate?.toDate?.()?.toISOString?.()  ?? doc.data().appliedDate,
    followUpDate: doc.data().followUpDate?.toDate?.()?.toISOString?.() ?? null,
    createdAt:    doc.data().createdAt?.toDate?.()?.toISOString?.()    ?? doc.data().createdAt,
    updatedAt:    doc.data().updatedAt?.toDate?.()?.toISOString?.()    ?? doc.data().updatedAt,
    // Never expose internal soft-delete fields to the API response
    deleted:      undefined,
    deletedAt:    undefined,
  }));

  return { applications, nextCursor, hasMore };
}

// ─── Get one (with ownership + deleted check) ─────────────────────────────────

async function getOne(applicationId, userId) {
  const doc = await db.collection(COLLECTION).doc(applicationId).get();

  if (!doc.exists) {
    throw new AppError('Application not found.', 404, { applicationId }, ErrorCodes.NOT_FOUND);
  }

  const data = doc.data();

  if (data.userId !== userId) {
    throw new AppError('Unauthorized.', 403, { applicationId }, ErrorCodes.FORBIDDEN);
  }

  // CHANGE 4: treat soft-deleted docs as not found
  if (data.deleted === true) {
    throw new AppError('Application not found.', 404, { applicationId }, ErrorCodes.NOT_FOUND);
  }

  return { id: doc.id, ...data };
}

// ─── Update ───────────────────────────────────────────────────────────────────

async function update(applicationId, userId, updates) {
  // getOne() now throws 404 for deleted docs — PATCH on deleted doc blocked automatically
  await getOne(applicationId, userId);

  const allowedFields = [
    'status', 'notes', 'followUpDate', 'companyName',
    'jobTitle', 'emailSentTo', 'appliedDate',
    'source',  // ← CHANGE 5
  ];
  const sanitized = {};

  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      if ((field === 'followUpDate' || field === 'appliedDate') && updates[field]) {
        sanitized[field] = new Date(updates[field]);
      } else {
        sanitized[field] = updates[field];
      }
    }
  }

  if (Object.keys(sanitized).length === 0) {
    throw new AppError('No valid fields to update.', 400, {}, ErrorCodes.VALIDATION_ERROR);
  }

  sanitized.updatedAt = new Date();

  await db.collection(COLLECTION).doc(applicationId).update(sanitized);

  logger.debug('[JobAppRepo] Updated', { applicationId, userId, fields: Object.keys(sanitized) });
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

  await db.collection(COLLECTION).doc(applicationId).update({
    deleted:   true,
    deletedAt: new Date(),
    updatedAt: new Date(),
  });

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
  VALID_SOURCES,   // ← CHANGE 5: exported for routes schema
};