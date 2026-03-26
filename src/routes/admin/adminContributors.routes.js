'use strict';

/**
 * adminContributors.routes.js
 *
 * MIGRATION: firebase-admin removed.
 *
 * Changes from original:
 *   - require('firebase-admin') + admin.auth().setCustomUserClaims()  → REMOVED
 *   - require('../../config/supabase') (db shim)                      → REMOVED
 *   - All DB reads/writes now use Supabase directly (service-role key)
 *   - Role claims now set via supabase.auth.admin.updateUserById()
 *     which writes to Supabase Auth app_metadata — the same field that
 *     auth.middleware.js reads (user.app_metadata.role).
 *   - Column names normalised to snake_case to match the Supabase users table:
 *       contributorPromotedAt → contributor_promoted_at
 *       contributorPromotedBy → contributor_promoted_by
 *       createdAt             → created_at
 *       displayName           → display_name
 *
 * Mount in server.js:
 *   app.use(
 *     `${API_PREFIX}/admin/contributors`,
 *     authenticate, requireAdmin,
 *     require('./routes/admin/adminContributors.routes')
 *   );
 *
 * Endpoints:
 *   GET    /admin/contributors           → list all contributors
 *   POST   /admin/contributors/promote   → grant contributor role to a user
 *   POST   /admin/contributors/demote    → revoke contributor role
 *
 * Environment variables required:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

const express          = require('express');
const { body }         = require('express-validator');
const { createClient } = require('@supabase/supabase-js');
const { validate }     = require('../../middleware/requestValidator');
const { asyncHandler } = require('../../utils/helpers');
const logger           = require('../../utils/logger');

const router = express.Router();

// ─── Supabase service-role client (singleton) ─────────────────────────────────
// Service-role key is required for auth.admin.updateUserById().
// Never expose this key to the browser.

let _supabase = null;

function getSupabase() {
  if (_supabase) return _supabase;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      '[adminContributors] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.'
    );
  }

  _supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return _supabase;
}

// ── GET /admin/contributors ───────────────────────────────────────────────────

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('users')
      .select('id, email, display_name, role, created_at, contributor_promoted_at, contributor_promoted_by')
      .eq('role', 'contributor')
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) {
      logger.error('[Contributors] Failed to list contributors', { error: error.message });
      return res.status(500).json({ success: false, errorCode: 'DB_ERROR', message: error.message });
    }

    const contributors = (data ?? []).map(row => ({
      uid:         row.id,
      email:       row.email,
      displayName: row.display_name,
      role:        row.role,
      createdAt:   row.created_at,
      promotedAt:  row.contributor_promoted_at ?? null,
      promotedBy:  row.contributor_promoted_by ?? null,
    }));

    return res.json({ success: true, data: { contributors, total: contributors.length } });
  })
);

// ── POST /admin/contributors/promote ─────────────────────────────────────────

router.post(
  '/promote',
  validate([
    body('uid').isString().trim().notEmpty().withMessage('uid is required'),
  ]),
  asyncHandler(async (req, res) => {
    const { uid }  = req.body;
    const adminUid = req.user.uid;
    const supabase = getSupabase();

    // Verify target user exists in the users table
    const { data: userData, error: fetchErr } = await supabase
      .from('users')
      .select('id, role')
      .eq('id', uid)
      .single();

    if (fetchErr || !userData) {
      return res.status(404).json({
        success: false, errorCode: 'NOT_FOUND', message: 'User not found.',
      });
    }

    if (['admin', 'super_admin', 'MASTER_ADMIN'].includes(userData.role)) {
      return res.status(409).json({
        success: false, errorCode: 'ALREADY_ADMIN',
        message: 'User already has admin or higher privileges.',
      });
    }

    const now = new Date().toISOString();

    // 1. Set role claim in Supabase Auth app_metadata.
    //    auth.middleware.js reads user.app_metadata.role — this is the correct place.
    const { error: authErr } = await supabase.auth.admin.updateUserById(uid, {
      app_metadata: { role: 'contributor', admin: false },
    });

    if (authErr) {
      logger.error('[Contributors] Failed to set Supabase Auth claim', {
        uid, error: authErr.message,
      });
      return res.status(500).json({
        success: false, errorCode: 'AUTH_UPDATE_FAILED', message: authErr.message,
      });
    }

    // 2. Update the users table (snake_case column names).
    const { error: dbErr } = await supabase
      .from('users')
      .update({
        role:                    'contributor',
        contributor_promoted_at: now,
        contributor_promoted_by: adminUid,
        updated_at:              now,
      })
      .eq('id', uid);

    if (dbErr) {
      // Auth claim was already set — log the inconsistency but don't fail the request.
      // The table will self-correct on the user's next profile update.
      logger.error('[Contributors] users table update failed after auth claim was set', {
        uid, error: dbErr.message,
      });
    }

    logger.info('[Contributors] User promoted to contributor', { uid, adminUid });

    return res.json({
      success: true,
      data: { uid, role: 'contributor', promotedAt: now, promotedBy: adminUid },
    });
  })
);

// ── POST /admin/contributors/demote ──────────────────────────────────────────

router.post(
  '/demote',
  validate([
    body('uid').isString().trim().notEmpty().withMessage('uid is required'),
  ]),
  asyncHandler(async (req, res) => {
    const { uid }  = req.body;
    const adminUid = req.user.uid;
    const supabase = getSupabase();

    // Cannot demote yourself
    if (uid === adminUid) {
      return res.status(400).json({
        success: false, errorCode: 'SELF_DEMOTE',
        message: 'You cannot demote yourself.',
      });
    }

    const { data: userData, error: fetchErr } = await supabase
      .from('users')
      .select('id')
      .eq('id', uid)
      .single();

    if (fetchErr || !userData) {
      return res.status(404).json({
        success: false, errorCode: 'NOT_FOUND', message: 'User not found.',
      });
    }

    const now = new Date().toISOString();

    // 1. Revert Supabase Auth claim back to regular user.
    const { error: authErr } = await supabase.auth.admin.updateUserById(uid, {
      app_metadata: { role: 'user', admin: false },
    });

    if (authErr) {
      logger.error('[Contributors] Failed to revert Supabase Auth claim', {
        uid, error: authErr.message,
      });
      return res.status(500).json({
        success: false, errorCode: 'AUTH_UPDATE_FAILED', message: authErr.message,
      });
    }

    // 2. Update the users table.
    const { error: dbErr } = await supabase
      .from('users')
      .update({ role: 'user', updated_at: now })
      .eq('id', uid);

    if (dbErr) {
      logger.error('[Contributors] users table update failed after demotion', {
        uid, error: dbErr.message,
      });
    }

    logger.info('[Contributors] Contributor demoted', { uid, adminUid });

    return res.json({ success: true, data: { uid, role: 'user' } });
  })
);

module.exports = router;








