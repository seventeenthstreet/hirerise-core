'use strict';

/**
 * src/routes/users.routes.js
 *
 * buildDefaultProfile() uses ONLY columns confirmed to exist in the
 * Supabase `users` table via information_schema.columns:
 *
 *   id, email, display_name, plan, role, user_type, career_goal,
 *   onboarding_completed, target_role, experience_years, location,
 *   tier, plan_amount, report_unlocked, resume_uploaded,
 *   subscription_id, subscription_provider, subscription_status,
 *   student_onboarding_complete, professional_onboarding_complete,
 *   created_at, updated_at
 *
 * Columns that do NOT exist in the table (never inserted):
 *   aiCreditsRemaining, ai_credits_remaining  → defaulted to 0 in normalizeUser
 *   chiScore, chi_score                       → defaulted to null in normalizeUser
 *   photoURL, photo_url                       → not in schema, omitted
 *   displayName                               → table uses display_name
 */

const express  = require('express');
const { body } = require('express-validator');
const { validate }              = require('../middleware/requestValidator');
const { updateUserProfile }     = require('../services/users.service');
const { getRemainingUses }      = require('../modules/analysis/analysis.constants');
const { getRemainingQuota }     = require('../middleware/tierquota.middleware');
const { getSubscriptionStatus } = require('../services/billing/Billing.service');
const logger   = require('../utils/logger');

// ─── Supabase client ──────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js');

let _supabase = null;

function getDb() {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('[users.routes] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  _supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return _supabase;
}

const router = express.Router();

// ─── Build default profile ────────────────────────────────────────────────────
// Uses ONLY columns confirmed to exist in the Supabase users table.

function buildDefaultProfile(reqUser) {
  return {
    id:                               reqUser.uid,
    email:                            reqUser.email   || '',
    display_name:                     reqUser.name    || null,
    plan:                             'free',
    tier:                             'free',
    plan_amount:                      null,
    role:                             'user',
    user_type:                        null,
    career_goal:                      null,
    target_role:                      null,
    location:                         null,
    experience_years:                 null,
    onboarding_completed:             false,
    onboarding_step:                  null,    // last completed step label
    resume_data:                      null,    // full ResumeData JSON
    profile_strength:                 0,       // 0-100 score
    report_unlocked:                  false,
    resume_uploaded:                  false,
    subscription_status:              'inactive',
    subscription_provider:            null,
    subscription_id:                  null,
    student_onboarding_complete:      false,
    professional_onboarding_complete: false,
    created_at:                       new Date().toISOString(),
    updated_at:                       new Date().toISOString(),
  };
}

// ─── Normalize DB row → API response shape ────────────────────────────────────
// Maps snake_case DB columns → camelCase shape the frontend expects.

function normalizeUser(row, reqUser) {
  return {
    ...row,
    // uid alias — frontend expects this field name
    uid:                  row.id                    ?? reqUser.uid,
    // Role/admin from verified JWT (authoritative)
    role:                 reqUser.role              ?? row.role  ?? null,
    admin:                reqUser.admin             ?? false,
    // camelCase aliases for frontend compatibility
    displayName:          row.display_name          ?? null,
    // ── Onboarding completion fields (new) ───────────────────────────────────
    onboarding_completed: row.onboarding_completed  ?? false,   // snake_case (DB column)
    onboardingCompleted:  row.onboarding_completed  ?? false,   // camelCase (frontend)
    onboarding_step:      row.onboarding_step       ?? null,    // last saved step
    profile_strength:     row.profile_strength      ?? 0,       // snake_case
    profileStrength:      row.profile_strength      ?? 0,       // camelCase
    // ─────────────────────────────────────────────────────────────────────────
    reportUnlocked:       row.report_unlocked       ?? false,
    resumeUploaded:       row.resume_uploaded        ?? false,
    subscriptionStatus:   row.subscription_status   ?? 'inactive',
    subscriptionProvider: row.subscription_provider ?? null,
    subscriptionId:       row.subscription_id       ?? null,
    planAmount:           row.plan_amount           ?? null,
    targetRole:           row.target_role           ?? null,
    experienceYears:      row.experience_years      ?? null,
    careerGoal:           row.career_goal           ?? null,
    // Not in schema — safe defaults for frontend compatibility
    aiCreditsRemaining:   0,
    chiScore:             null,
  };
}

// ─── GET /api/v1/users/me ─────────────────────────────────────────────────────

router.get('/me', async (req, res, next) => {
  try {
    const userId   = req.user.uid;
    const supabase = getDb();

    let { data: row, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId)
      .single();

    // PGRST116 = "The result contains 0 rows" — first-time login
    if (error?.code === 'PGRST116' || (!error && !row)) {
      logger.info('[UsersRoute] First login — creating default profile', { userId });

      const defaultProfile = buildDefaultProfile(req.user);

      // Use upsert (onConflict: 'id') so that parallel first-login requests
      // don't race each other into a duplicate-key error on users_email_key.
      // ignoreDuplicates: false ensures we still get the row back via .select().
      const { data: newRow, error: upsertErr } = await supabase
        .from('users')
        .upsert(defaultProfile, { onConflict: 'id', ignoreDuplicates: false })
        .select()
        .single();

      if (upsertErr) {
        // Duplicate key on email means another concurrent request already
        // created the profile — re-fetch the row rather than returning 500.
        if (
          upsertErr.code === '23505' ||
          (upsertErr.message && upsertErr.message.includes('duplicate key'))
        ) {
          logger.warn('[UsersRoute] Duplicate profile insert detected — re-fetching existing row', { userId });

          const { data: existingRow, error: refetchErr } = await supabase
            .from('users')
            .select('*')
            .eq('id', userId)
            .single();

          if (refetchErr) {
            logger.error('[UsersRoute] Failed to re-fetch user after duplicate insert', {
              userId,
              error: refetchErr.message,
            });
            return next(refetchErr);
          }

          row = existingRow;
        } else {
          logger.error('[UsersRoute] Failed to create default profile', {
            userId,
            error: upsertErr.message,
          });
          return next(upsertErr);
        }
      } else {
        row = newRow;
      }

    } else if (error) {
      logger.error('[UsersRoute] Failed to fetch user', {
        userId, error: error.message, code: error.code,
      });
      return next(error);
    }

    const userDoc = normalizeUser(row, req.user);

    // ── Subscription status — best-effort, hard 3 s timeout ─────────────────
    // getSubscriptionStatus() hits Firestore/Supabase and can hang on cold
    // starts or slow DB connections, which was blocking the entire /users/me
    // response and causing the frontend spinner to never resolve.
    //
    // BUG FIX: getSubscriptionStatus() returns an object { status, tier, ... }
    // not a plain string — extract `.status` so we don't write "[object Object]"
    // into the response.
    let subscriptionStatus = row.subscription_status ?? 'inactive';
    try {
      const subResult = await Promise.race([
        getSubscriptionStatus(userId),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('getSubscriptionStatus timeout')), 3000)
        ),
      ]);
      // subResult is { userId, tier, status, ... } — extract the string field
      subscriptionStatus = subResult?.status ?? subResult ?? subscriptionStatus;
    } catch (err) {
      logger.warn('[UsersRoute] getSubscriptionStatus failed or timed out — using DB value', {
        userId, reason: err.message,
      });
    }

    // ── Remaining quota — best-effort, hard 3 s timeout ─────────────────────
    // getRemainingQuota() queries user_quota table; same timeout guard applied.
    const quota = await Promise.race([
      getRemainingQuota(req).catch(() => null),
      new Promise(resolve => setTimeout(() => resolve(null), 3000)),
    ]);

    return res.json({
      success: true,
      data: {
        user: { ...userDoc, subscriptionStatus },
        credits: {
          remaining:     0,
          remainingUses: getRemainingUses(userDoc) ?? null,
        },
        quota: { remaining: quota, resetDate: null },
      },
    });

  } catch (err) {
    return next(err);
  }
});

// ─── PATCH /api/v1/users/me ───────────────────────────────────────────────────

const PATCH_ALLOWED_KEYS = new Set([
  'name', 'location', 'experienceYears', 'targetRole', 'bio', 'user_type', 'careerGoal',
]);

router.patch(
  '/me',
  validate([
    body().custom((body) => {
      const unknown = Object.keys(body).filter(k => !PATCH_ALLOWED_KEYS.has(k));
      if (unknown.length) throw new Error(`Unknown field(s): ${unknown.join(', ')}`);
      return true;
    }),
    body('name').optional().isString().trim().isLength({ max: 100 }),
    body('location').optional().isString().trim().isLength({ max: 100 }),
    body('experienceYears').optional().isFloat({ min: 0, max: 50 }).toFloat(),
    body('targetRole').optional().isString().trim().isLength({ max: 100 }),
    body('bio').optional().isString().trim().isLength({ max: 500 }),
    body('careerGoal').optional().isString().trim().isLength({ max: 200 }),
    body('user_type').optional().isIn(['student', 'professional'])
      .withMessage("user_type must be 'student' or 'professional'"),
  ]),
  async (req, res, next) => {
    try {
      const userId = req.user.uid;
      logger.info('[UsersRoute] PATCH /me', { userId, fields: Object.keys(req.body) });
      const updatedUser = await updateUserProfile(userId, req.body);
      return res.json({ success: true, data: updatedUser });
    } catch (err) {
      return next(err);
    }
  }
);

// ─── GET /api/v1/users/me/subscription ───────────────────────────────────────

router.get('/me/subscription', async (req, res, next) => {
  try {
    const userId   = req.user.uid;
    const supabase = getDb();

    const { data, error } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) return next(error);
    return res.json({ success: true, data: data ?? null });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;








