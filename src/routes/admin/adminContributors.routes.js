'use strict';

/**
 * src/routes/admin/adminContributors.routes.js
 *
 * Fully Supabase-native contributor management.
 * Uses shared production singleton from config/supabase.js
 *
 * Features:
 *  - Router-level admin authorization
 *  - roles[] + app_metadata.role + role compatibility
 *  - Cursor pagination
 *  - Already contributor protection
 *  - Peer admin protection
 *  - Partial failure surfacing (207)
 *  - Retry-safe Supabase operations
 *  - Backward-compatible API responses
 */

const express = require('express');
const { body, query } = require('express-validator');

const { validate } = require('../../middleware/requestValidator');
const { asyncHandler } = require('../../utils/helpers');
const { getClient, withRetry } = require('../../config/supabase');
const logger = require('../../utils/logger');

const router = express.Router();

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────
const ADMIN_ROLES = new Set([
  'admin',
  'super_admin',
  'MASTER_ADMIN',
]);

const PAGE_LIMIT_DEFAULT = 50;
const PAGE_LIMIT_MAX = 200;

// ─────────────────────────────────────────────
// Authorization helpers
// ─────────────────────────────────────────────
function hasAdminAccess(req) {
  const directRole = req.user?.role;
  const metadataRole = req.user?.app_metadata?.role;
  const roles = Array.isArray(req.user?.roles) ? req.user.roles : [];

  return (
    ADMIN_ROLES.has(directRole) ||
    ADMIN_ROLES.has(metadataRole) ||
    roles.some(role => ADMIN_ROLES.has(role))
  );
}

router.use((req, res, next) => {
  if (!hasAdminAccess(req)) {
    return res.status(403).json({
      success: false,
      errorCode: 'FORBIDDEN',
      message: 'Insufficient privileges.',
    });
  }

  return next();
});

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function getActorId(req) {
  return req.user?.uid ?? req.user?.id ?? null;
}

function mapContributor(row) {
  return {
    uid: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    createdAt: row.created_at,
    promotedAt: row.contributor_promoted_at ?? null,
    promotedBy: row.contributor_promoted_by ?? null,
  };
}

// ─────────────────────────────────────────────
// GET /
// Cursor pagination: ?cursor=<ISO>&limit=<n>
// ─────────────────────────────────────────────
router.get(
  '/',
  validate([
    query('limit')
      .optional()
      .isInt({ min: 1, max: PAGE_LIMIT_MAX })
      .toInt()
      .withMessage(`limit must be between 1 and ${PAGE_LIMIT_MAX}`),

    query('cursor')
      .optional()
      .isISO8601()
      .withMessage('cursor must be a valid ISO 8601 timestamp'),
  ]),
  asyncHandler(async (req, res) => {
    const db = getClient();
    const limit = req.query.limit ?? PAGE_LIMIT_DEFAULT;
    const cursor = req.query.cursor ?? null;

    let queryBuilder = db
      .from('users')
      .select(`
        id,
        email,
        display_name,
        role,
        created_at,
        contributor_promoted_at,
        contributor_promoted_by
      `)
      .eq('role', 'contributor')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (cursor) {
      queryBuilder = queryBuilder.lt('created_at', cursor);
    }

    const { data, error } = await withRetry(() => queryBuilder);

    if (error) {
      logger.error('[Contributors] Failed to list contributors', {
        error: error.message,
      });

      return res.status(500).json({
        success: false,
        errorCode: 'DB_ERROR',
        message: 'Failed to fetch contributors.',
      });
    }

    const contributors = (data ?? []).map(mapContributor);

    const nextCursor =
      contributors.length === limit
        ? contributors[contributors.length - 1].createdAt
        : null;

    return res.json({
      success: true,
      data: {
        contributors,
        total: contributors.length,
        nextCursor,
      },
    });
  })
);

// ─────────────────────────────────────────────
// POST /promote
// ─────────────────────────────────────────────
router.post(
  '/promote',
  validate([
    body('uid')
      .isString()
      .trim()
      .notEmpty()
      .withMessage('uid is required'),
  ]),
  asyncHandler(async (req, res) => {
    const db = getClient();
    const actorId = getActorId(req);

    if (!actorId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthenticated',
      });
    }

    const { uid } = req.body;

    const { data: user, error: fetchErr } = await withRetry(() =>
      db
        .from('users')
        .select('id, role')
        .eq('id', uid)
        .maybeSingle()
    );

    if (fetchErr) {
      logger.error('[Contributors] Failed to fetch target user', {
        uid,
        error: fetchErr.message,
      });

      return res.status(500).json({
        success: false,
        errorCode: 'DB_ERROR',
        message: 'Failed to verify user.',
      });
    }

    if (!user) {
      return res.status(404).json({
        success: false,
        errorCode: 'NOT_FOUND',
        message: 'User not found.',
      });
    }

    if (user.role === 'contributor') {
      return res.status(409).json({
        success: false,
        errorCode: 'ALREADY_CONTRIBUTOR',
        message: 'User is already a contributor.',
      });
    }

    if (ADMIN_ROLES.has(user.role)) {
      return res.status(409).json({
        success: false,
        errorCode: 'ALREADY_ADMIN',
        message: 'User already has admin or higher privileges.',
      });
    }

    const now = new Date().toISOString();

    const { error: authErr } = await withRetry(() =>
      db.auth.admin.updateUserById(uid, {
        app_metadata: {
          role: 'contributor',
          admin: false,
        },
      })
    );

    if (authErr) {
      logger.error('[Contributors] Failed auth metadata update', {
        uid,
        error: authErr.message,
      });

      return res.status(500).json({
        success: false,
        errorCode: 'AUTH_UPDATE_FAILED',
        message: 'Failed to update auth role.',
      });
    }

    const { error: dbErr } = await withRetry(() =>
      db
        .from('users')
        .update({
          role: 'contributor',
          contributor_promoted_at: now,
          contributor_promoted_by: actorId,
          updated_at: now,
        })
        .eq('id', uid)
    );

    if (dbErr) {
      logger.error(
        '[Contributors] Mirror table sync failed after auth promote',
        {
          uid,
          error: dbErr.message,
        }
      );

      return res.status(207).json({
        success: true,
        warning:
          `Auth metadata updated but database sync failed. ` +
          `Manual reconciliation required for uid: ${uid}`,
        data: {
          uid,
          role: 'contributor',
          promotedAt: now,
          promotedBy: actorId,
        },
      });
    }

    logger.info('[Contributors] User promoted', {
      uid,
      promotedBy: actorId,
    });

    return res.json({
      success: true,
      data: {
        uid,
        role: 'contributor',
        promotedAt: now,
        promotedBy: actorId,
      },
    });
  })
);

// ─────────────────────────────────────────────
// POST /demote
// ─────────────────────────────────────────────
router.post(
  '/demote',
  validate([
    body('uid')
      .isString()
      .trim()
      .notEmpty()
      .withMessage('uid is required'),
  ]),
  asyncHandler(async (req, res) => {
    const db = getClient();
    const actorId = getActorId(req);

    if (!actorId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthenticated',
      });
    }

    const { uid } = req.body;

    if (uid === actorId) {
      return res.status(400).json({
        success: false,
        errorCode: 'SELF_DEMOTE',
        message: 'You cannot demote yourself.',
      });
    }

    const { data: user, error: fetchErr } = await withRetry(() =>
      db
        .from('users')
        .select('id, role')
        .eq('id', uid)
        .maybeSingle()
    );

    if (fetchErr) {
      logger.error(
        '[Contributors] Failed to fetch target user for demotion',
        {
          uid,
          error: fetchErr.message,
        }
      );

      return res.status(500).json({
        success: false,
        errorCode: 'DB_ERROR',
        message: 'Failed to verify user.',
      });
    }

    if (!user) {
      return res.status(404).json({
        success: false,
        errorCode: 'NOT_FOUND',
        message: 'User not found.',
      });
    }

    if (ADMIN_ROLES.has(user.role)) {
      return res.status(403).json({
        success: false,
        errorCode: 'CANNOT_DEMOTE_ADMIN',
        message: 'Cannot demote a user with admin privileges.',
      });
    }

    const now = new Date().toISOString();

    const { error: authErr } = await withRetry(() =>
      db.auth.admin.updateUserById(uid, {
        app_metadata: {
          role: 'user',
          admin: false,
        },
      })
    );

    if (authErr) {
      logger.error('[Contributors] Failed auth demotion', {
        uid,
        error: authErr.message,
      });

      return res.status(500).json({
        success: false,
        errorCode: 'AUTH_UPDATE_FAILED',
        message: 'Failed to update auth role.',
      });
    }

    const { error: dbErr } = await withRetry(() =>
      db
        .from('users')
        .update({
          role: 'user',
          updated_at: now,
        })
        .eq('id', uid)
    );

    if (dbErr) {
      logger.error(
        '[Contributors] Mirror table sync failed after auth demote',
        {
          uid,
          error: dbErr.message,
        }
      );

      return res.status(207).json({
        success: true,
        warning:
          `Auth metadata updated but database sync failed. ` +
          `Manual reconciliation required for uid: ${uid}`,
        data: {
          uid,
          role: 'user',
        },
      });
    }

    logger.info('[Contributors] User demoted', {
      uid,
      demotedBy: actorId,
    });

    return res.json({
      success: true,
      data: {
        uid,
        role: 'user',
      },
    });
  })
);

module.exports = router;