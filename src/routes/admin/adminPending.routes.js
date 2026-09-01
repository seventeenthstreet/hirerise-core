'use strict';

/**
 * src/routes/admin/adminPending.routes.js
 *
 * Production-ready contributor submission workflow
 * - Supabase singleton safe
 * - Atomic approval via SQL RPC
 * - Retry safe
 * - Hardened RPC error classification
 * - Contributor + admin RBAC safe
 */

const express = require('express');
const { body, param, query } = require('express-validator');

const { validate } = require('../../middleware/requestValidator');
const { requireAdmin } = require('../../middleware/auth.middleware');
const { requireContributor } = require('../../middleware/requireContributor.middleware');
const { requireEditor } = require('../../middleware/requireEditor.middleware');
const { asyncHandler } = require('../../utils/helpers');
const { getClient, withRetry } = require('../../config/supabase');
const logger = require('../../utils/logger');

const router = express.Router();

const SUPPORTED_ENTITY_TYPES = Object.freeze([
  'skill',
  'role',
  'jobFamily',
  'educationLevel',
  'salaryBenchmark',
]);

// CONTRACT NOTE (Phase 2): errorCode renamed to `code` to align with V2 contract.
// The approve route builds { error: { code: classified.code, message } } from these entries.
const RPC_ERROR_MAP = Object.freeze({
  PENDING_NOT_FOUND: {
    status: 404,
    code: 'NOT_FOUND',
    message: 'Entry not found.',
  },
  ALREADY_REVIEWED: {
    status: 409,
    code: 'ALREADY_REVIEWED',
    message: 'Entry has already been reviewed.',
  },
  INVALID_ENTITY_TYPE: {
    status: 400,
    code: 'INVALID_ENTITY_TYPE',
    message: 'Unsupported entity type.',
  },
  LIVE_INSERT_FAILED: {
    status: 500,
    code: 'LIVE_INSERT_FAILED',
    message: 'Failed to create live CMS record.',
  },
  CONCURRENT_APPROVAL: {
    status: 409,
    code: 'CONCURRENT_APPROVAL',
    message:
      'Another approval is in progress for this entry. Please retry.',
  },
});

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function getDb() {
  return getClient();
}

function getActorId(req) {
  return req.user?.uid ?? req.user?.id ?? null;
}

function isMasterOrAdmin(req) {
  const role = req.user?.role ?? '';
  const roles = Array.isArray(req.user?.roles)
    ? req.user.roles
    : [];

  return (
    req.user?.admin === true ||
    ['admin', 'super_admin', 'MASTER_ADMIN'].includes(role) ||
    roles.some(r =>
      ['admin', 'super_admin', 'MASTER_ADMIN'].includes(r)
    )
  );
}

// Editor role check (WP-ADMIN-COMP-EDITOR-01). Editor never submits or
// withdraws entries (POST / and DELETE /:id stay requireContributor-only,
// unchanged), but — like an Admin — is not scoped to "own" submissions:
// Editor's whole purpose is reviewing/editing entries submitted by
// Contributors, so ownership scoping (see GET / and GET /:id below) must
// exclude Editor the same way it already excludes Admin/MASTER_ADMIN.
function isEditorRole(req) {
  const role = req.user?.role ?? '';
  const roles = Array.isArray(req.user?.roles) ? req.user.roles : [];
  return role === 'editor' || roles.includes('editor');
}

// GET / and GET /:id are the one part of this router genuinely shared by
// both ordinary roles (Contributor sees/looks up its own entries; Editor
// needs to see all pending entries in order to review/edit them). Neither
// requireContributor nor requireEditor alone admits the other role, so this
// is a small local OR rather than weakening either existing gate.
function requireContributorOrEditor(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Authentication required.' },
      meta: { timestamp: new Date().toISOString() },
    });
  }

  const role = req.user.role ?? '';
  const roles = Array.isArray(req.user.roles) ? req.user.roles : [];
  const allowed = ['contributor', 'editor', 'admin', 'super_admin', 'MASTER_ADMIN'];

  const hasAccess =
    req.user.admin === true ||
    allowed.includes(role) ||
    roles.some(r => allowed.includes(r));

  if (!hasAccess) {
    return res.status(403).json({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Contributor or Editor privileges required.' },
      meta: { timestamp: new Date().toISOString() },
    });
  }

  return next();
}

function toCamel(row) {
  if (!row) return null;

  return {
    id:              row.id,
    entityType:      row.entity_type,
    payload:         row.payload,
    status:          row.status,
    submittedByUid:  row.submitted_by,
    submittedAt:     row.submitted_at,
    reviewedByUid:   row.reviewed_by,
    reviewedAt:      row.reviewed_at,
    rejectionReason: row.review_notes,
    liveId:          row.live_id,
  };
}

/**
 * Production-safe RPC error classifier.
 * Handles SQLSTATE codes + Supabase-wrapped Postgres messages.
 */
function classifyRpcError(error) {
  if (!error) return null;

  // PostgreSQL NOWAIT lock conflict → SQLSTATE 55P03
  if (error.code === '55P03') {
    return RPC_ERROR_MAP.CONCURRENT_APPROVAL;
  }

  const rawMessage = String(error.message || '').toUpperCase();

  for (const [key, mapped] of Object.entries(RPC_ERROR_MAP)) {
    if (key === 'CONCURRENT_APPROVAL') continue;

    if (rawMessage.includes(key)) {
      return mapped;
    }
  }

  return null;
}

// ─────────────────────────────────────────────
// POST /
// Submit new pending entry (contributor only)
// ─────────────────────────────────────────────

router.post(
  '/',
  requireContributor,
  validate([
    body('entityType')
      .isIn(SUPPORTED_ENTITY_TYPES)
      .withMessage(
        `entityType must be one of: ${SUPPORTED_ENTITY_TYPES.join(', ')}`
      ),
    body('payload')
      .isObject()
      .withMessage('payload must be an object'),
    body('payload.name')
      .isString()
      .trim()
      .notEmpty()
      .withMessage('payload.name is required'),
    body('submittedByUid').not().exists(),
    body('status').not().exists(),
  ]),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const actorId = getActorId(req);
    const { entityType, payload } = req.body;

    const { data, error } = await withRetry(() =>
      db
        .from('pending_entries')
        .insert({
          entity_type:  entityType,
          payload,
          status:       'pending',
          submitted_by: actorId,
          submitted_at: new Date().toISOString(),
        })
        .select()
        .single()
    );

    if (error) {
      throw new Error(`Failed to submit entry: ${error.message}`);
    }

    logger.info('[Pending] Entry submitted', {
      id: data.id,
      entityType,
      actorId,
    });

    return res.status(201).json({
      success: true,
      data: toCamel(data),
    });
  })
);

// ─────────────────────────────────────────────
// GET /
// List pending entries.
// Admins see all; contributors see only their own.
// ─────────────────────────────────────────────

router.get(
  '/',
  requireContributorOrEditor,
  validate([
    query('status')
      .optional()
      .isIn(['pending', 'approved', 'rejected']),
    query('entityType')
      .optional()
      .isIn(SUPPORTED_ENTITY_TYPES),
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 }),
  ]),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const actorId = getActorId(req);
    const { status, entityType, limit = '50' } = req.query;

    const maxRows = parseInt(limit, 10);

    let q = db
      .from('pending_entries')
      .select('*')
      .order('submitted_at', { ascending: false })
      .limit(maxRows);

    // Contributor is scoped to its own submissions. Admin/MASTER_ADMIN and
    // Editor are not — Editor reviews entries Contributors submitted, so
    // scoping to "own" would show Editor nothing (Editor never submits).
    if (!isMasterOrAdmin(req) && !isEditorRole(req)) {
      q = q.eq('submitted_by', actorId);
    }

    if (status)     q = q.eq('status', status);
    if (entityType) q = q.eq('entity_type', entityType);

    const { data, error } = await withRetry(() => q);

    if (error) {
      throw new Error(error.message);
    }

    const items = (data ?? []).map(toCamel);

    return res.json({
      success: true,
      data: {
        items,
        total: items.length,
      },
    });
  })
);

// ─────────────────────────────────────────────
// GET /:id
// Fetch a single pending entry by UUID.
// Admins can fetch any entry; contributors can
// only fetch their own.
// ─────────────────────────────────────────────

router.get(
  '/:id',
  requireContributorOrEditor,
  validate([param('id').isUUID()]),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const actorId = getActorId(req);

    const { data, error } = await withRetry(() =>
      db
        .from('pending_entries')
        .select('*')
        .eq('id', req.params.id)
        .single()
    );

    if (error || !data) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Entry not found.',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    if (!isMasterOrAdmin(req) && !isEditorRole(req) && data.submitted_by !== actorId) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Access denied.',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    return res.json({
      success: true,
      data: toCamel(data),
    });
  })
);

// ─────────────────────────────────────────────
// POST /:id/approve
// Atomic approval via SQL RPC.
// Entire operation (lock → insert → update) runs
// in one Postgres transaction — no partial failure.
//
// RPC error codes:
//   PENDING_NOT_FOUND   → 404
//   ALREADY_REVIEWED    → 409
//   INVALID_ENTITY_TYPE → 400
//   LIVE_INSERT_FAILED  → 500
//   55P03 (NOWAIT lock) → 409 CONCURRENT_APPROVAL
// ─────────────────────────────────────────────

router.post(
  '/:id/approve',
  requireAdmin,
  validate([param('id').isUUID()]),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const actorId = getActorId(req);

    if (!actorId) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Unauthenticated.',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    const { data, error } = await withRetry(() =>
      db.rpc('approve_pending_entry_transaction', {
        p_pending_id: req.params.id,
        p_admin_uid:  actorId,
      })
    );

    if (error) {
      const classified = classifyRpcError(error);

      if (classified) {
        return res.status(classified.status).json({
          success: false,
          error: {
            code: classified.code,
            message: classified.message,
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      logger.error('[Pending] RPC approval failed', {
        pendingId: req.params.id,
        actorId,
        error: error.message,
        code:  error.code,
      });

      return res.status(500).json({
        success: false,
        error: {
          code: 'RPC_FAILURE',
          message: 'Approval transaction failed.',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    if (!data?.success || !data?.live_id) {
      logger.error('[Pending] RPC malformed response', {
        pendingId: req.params.id,
        actorId,
        data,
      });

      return res.status(500).json({
        success: false,
        error: {
          code: 'RPC_INVALID_RESPONSE',
          message: 'Approval completed with invalid RPC response.',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    logger.info('[Pending] Entry approved via RPC', {
      pendingId: data.pending_id,
      liveId:    data.live_id,
      table:     data.live_table,
      actorId,
    });

    return res.json({
      success: true,
      data: {
        pendingId: data.pending_id,
        liveId:    data.live_id,
        table:     data.live_table,
      },
    });
  })
);

// ─────────────────────────────────────────────
// POST /:id/reject
// Reject a pending entry with a mandatory reason.
// ─────────────────────────────────────────────

router.post(
  '/:id/reject',
  requireAdmin,
  validate([
    param('id').isUUID(),
    body('reason')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: 500 })
      .withMessage(
        'A rejection reason is required (max 500 chars)'
      ),
  ]),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const actorId = getActorId(req);

    const { data: entry, error } = await withRetry(() =>
      db
        .from('pending_entries')
        .select('status')
        .eq('id', req.params.id)
        .single()
    );

    if (error || !entry) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Entry not found.',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    if (entry.status !== 'pending') {
      return res.status(409).json({
        success: false,
        error: {
          code: 'ALREADY_REVIEWED',
          message: `Entry has already been ${entry.status}.`,
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    await withRetry(() =>
      db
        .from('pending_entries')
        .update({
          status:       'rejected',
          reviewed_by:  actorId,
          reviewed_at:  new Date().toISOString(),
          review_notes: req.body.reason,
        })
        .eq('id', req.params.id)
    );

    logger.info('[Pending] Entry rejected', {
      pendingId: req.params.id,
      actorId,
    });

    return res.json({
      success: true,
      data: {
        id:     req.params.id,
        status: 'rejected',
      },
    });
  })
);

// ─────────────────────────────────────────────
// DELETE /:id
// Withdraw a pending or rejected submission.
// Admins can withdraw any entry; contributors
// can only withdraw their own. Approved entries
// cannot be withdrawn.
// ─────────────────────────────────────────────

router.delete(
  '/:id',
  requireContributor,
  validate([param('id').isUUID()]),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const actorId = getActorId(req);

    const { data: entry, error } = await withRetry(() =>
      db
        .from('pending_entries')
        .select('*')
        .eq('id', req.params.id)
        .single()
    );

    if (error || !entry) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Entry not found.',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    if (!isMasterOrAdmin(req) && entry.submitted_by !== actorId) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'You can only withdraw your own submissions.',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    if (entry.status === 'approved') {
      return res.status(409).json({
        success: false,
        error: {
          code: 'ALREADY_APPROVED',
          message: 'Approved entries cannot be withdrawn.',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    await withRetry(() =>
      db
        .from('pending_entries')
        .delete()
        .eq('id', req.params.id)
    );

    return res.json({
      success: true,
      data: {
        id:      req.params.id,
        deleted: true,
      },
    });
  })
);

// ─────────────────────────────────────────────
// PATCH /:id
// Editor-only: edit the payload of a still-pending
// (pre-publish) entry. Entity type, status, and the
// original submitter can never be changed here —
// editing is a payload-content action, not a
// reassignment or a publish. Approval/rejection
// remain exclusively requireAdmin (see above); this
// route grants no publishing authority.
// ─────────────────────────────────────────────

router.patch(
  '/:id',
  requireEditor,
  validate([
    param('id').isUUID(),
    body('payload')
      .isObject()
      .withMessage('payload must be an object'),
    body('payload.name')
      .isString()
      .trim()
      .notEmpty()
      .withMessage('payload.name is required'),
    body('entityType').not().exists(),
    body('status').not().exists(),
    body('submittedByUid').not().exists(),
  ]),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const actorId = getActorId(req);

    const { data: entry, error } = await withRetry(() =>
      db
        .from('pending_entries')
        .select('status')
        .eq('id', req.params.id)
        .single()
    );

    if (error || !entry) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Entry not found.',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    if (entry.status !== 'pending') {
      return res.status(409).json({
        success: false,
        error: {
          code: 'ALREADY_REVIEWED',
          message: `Entry has already been ${entry.status} and can no longer be edited.`,
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    const { data, error: updateError } = await withRetry(() =>
      db
        .from('pending_entries')
        .update({ payload: req.body.payload })
        .eq('id', req.params.id)
        .select()
        .single()
    );

    if (updateError) {
      throw new Error(`Failed to update entry: ${updateError.message}`);
    }

    logger.info('[Pending] Entry edited by Editor', {
      id: req.params.id,
      actorId,
    });

    return res.json({
      success: true,
      data: toCamel(data),
    });
  })
);

module.exports = router;