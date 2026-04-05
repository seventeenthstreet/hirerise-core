'use strict';

/**
 * src/routes/users.routes.js
 *
 * Fully Supabase-native
 * Production-hardened
 */

const express = require('express');
const { body } = require('express-validator');

const { validate } = require('../middleware/requestValidator');
const { asyncHandler } = require('../utils/helpers');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const { updateUserProfile } = require('../services/users.service');
const { getRemainingUses } = require('../modules/analysis/analysis.constants');
const { getRemainingQuota } = require('../middleware/tierquota.middleware');
const { getSubscriptionStatus } = require('../services/billing/Billing.service');
const supabase = require('../lib/supabaseClient');
const logger = require('../utils/logger');

const router = express.Router();

function getUserId(req) {
  const userId =
    req.user?.id ||
    req.auth?.userId ||
    req.user?.user_id ||
    req.user?.uid;

  if (!userId || typeof userId !== 'string') {
    throw new AppError(
      'Unauthorized',
      401,
      {},
      ErrorCodes.UNAUTHORIZED,
    );
  }

  return userId;
}

/**
 * Uses ONLY columns confirmed to exist in users table.
 * DB owns timestamps via triggers/defaults.
 */
function buildDefaultProfile(reqUser, userId) {
  return {
    id: userId,
    email: reqUser.email || '',
    display_name: reqUser.name || null,
    plan: 'free',
    tier: 'free',
    plan_amount: null,
    role: 'user',
    user_type: null,
    career_goal: null,
    target_role: null,
    location: null,
    experience_years: null,
    onboarding_completed: false,
    report_unlocked: false,
    resume_uploaded: false,
    subscription_status: 'inactive',
    subscription_provider: null,
    subscription_id: null,
    student_onboarding_complete: false,
    professional_onboarding_complete: false,
  };
}

function normalizeUser(row, reqUser, userId) {
  return {
    ...row,
    uid: row.id ?? userId,
    role: reqUser.role ?? row.role ?? null,
    admin: reqUser.admin ?? false,
    displayName: row.display_name ?? null,
    onboarding_completed: row.onboarding_completed ?? false,
    onboardingCompleted: row.onboarding_completed ?? false,
    reportUnlocked: row.report_unlocked ?? false,
    resumeUploaded: row.resume_uploaded ?? false,
    subscriptionStatus: row.subscription_status ?? 'inactive',
    subscriptionProvider: row.subscription_provider ?? null,
    subscriptionId: row.subscription_id ?? null,
    planAmount: row.plan_amount ?? null,
    targetRole: row.target_role ?? null,
    experienceYears: row.experience_years ?? null,
    careerGoal: row.career_goal ?? null,
    aiCreditsRemaining: 0,
    chiScore: null,
  };
}

// ─────────────────────────────────────────────────────────────
// GET /me
// ─────────────────────────────────────────────────────────────
router.get(
  '/me',
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);

    let { data: row, error } = await supabase
      .from('users')
      .select(`
        id,email,display_name,plan,role,user_type,career_goal,
        onboarding_completed,target_role,experience_years,location,
        tier,plan_amount,report_unlocked,resume_uploaded,
        subscription_id,subscription_provider,subscription_status,
        student_onboarding_complete,professional_onboarding_complete,
        created_at,updated_at
      `)
      .eq('id', userId)
      .maybeSingle();

    if (error) {
      throw new AppError(
        error.message,
        500,
        { code: error.code },
        ErrorCodes.INTERNAL_ERROR,
      );
    }

    if (!row) {
      logger.info('[UsersRoute] First login — creating default profile', {
        userId,
      });

      const defaultProfile = buildDefaultProfile(req.user, userId);

      const { data: newRow, error: upsertErr } = await supabase
        .from('users')
        .upsert(defaultProfile, {
          onConflict: 'id',
          ignoreDuplicates: false,
        })
        .select(`
          id,email,display_name,plan,role,user_type,career_goal,
          onboarding_completed,target_role,experience_years,location,
          tier,plan_amount,report_unlocked,resume_uploaded,
          subscription_id,subscription_provider,subscription_status,
          student_onboarding_complete,professional_onboarding_complete,
          created_at,updated_at
        `)
        .maybeSingle();

      if (upsertErr) {
        throw new AppError(
          upsertErr.message,
          500,
          { code: upsertErr.code },
          ErrorCodes.INTERNAL_ERROR,
        );
      }

      row = newRow;
    }

    const userDoc = normalizeUser(row, req.user, userId);

    let subscriptionStatus = row.subscription_status ?? 'inactive';

    try {
      const subResult = await Promise.race([
        getSubscriptionStatus(userId),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('getSubscriptionStatus timeout')),
            3000,
          ),
        ),
      ]);

      subscriptionStatus =
        subResult?.status ?? subResult ?? subscriptionStatus;
    } catch (err) {
      logger.warn(
        '[UsersRoute] getSubscriptionStatus failed or timed out',
        {
          userId,
          reason: err.message,
        },
      );
    }

    const quota = await Promise.race([
      getRemainingQuota(req).catch(() => null),
      new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
    ]);

    return res.json({
      success: true,
      data: {
        user: { ...userDoc, subscriptionStatus },
        credits: {
          remaining: 0,
          remainingUses: getRemainingUses(userDoc) ?? null,
        },
        quota: {
          remaining: quota,
          resetDate: null,
        },
      },
    });
  }),
);

// ─────────────────────────────────────────────────────────────
// PATCH /me
// ─────────────────────────────────────────────────────────────
const PATCH_ALLOWED_KEYS = new Set([
  'name',
  'location',
  'experienceYears',
  'targetRole',
  'bio',
  'user_type',
  'careerGoal',
]);

router.patch(
  '/me',
  validate([
    body().custom((payload) => {
      const unknown = Object.keys(payload).filter(
        (k) => !PATCH_ALLOWED_KEYS.has(k),
      );
      if (unknown.length) {
        throw new Error(`Unknown field(s): ${unknown.join(', ')}`);
      }
      return true;
    }),
    body('name').optional().isString().trim().isLength({ max: 100 }),
    body('location').optional().isString().trim().isLength({ max: 100 }),
    body('experienceYears')
      .optional()
      .isFloat({ min: 0, max: 50 })
      .toFloat(),
    body('targetRole')
      .optional()
      .isString()
      .trim()
      .isLength({ max: 100 }),
    body('bio').optional().isString().trim().isLength({ max: 500 }),
    body('careerGoal')
      .optional()
      .isString()
      .trim()
      .isLength({ max: 200 }),
    body('user_type')
      .optional()
      .isIn(['student', 'professional']),
  ]),
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);

    logger.info('[UsersRoute] PATCH /me', {
      userId,
      fields: Object.keys(req.body),
    });

    const updatedUser = await updateUserProfile(userId, req.body);

    return res.json({
      success: true,
      data: updatedUser,
    });
  }),
);

// ─────────────────────────────────────────────────────────────
// GET /me/subscription
// ─────────────────────────────────────────────────────────────
router.get(
  '/me/subscription',
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);

    const { data, error } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      throw new AppError(
        error.message,
        500,
        { code: error.code },
        ErrorCodes.INTERNAL_ERROR,
      );
    }

    return res.json({
      success: true,
      data: data ?? null,
    });
  }),
);

module.exports = router;