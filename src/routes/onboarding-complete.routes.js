'use strict';

/**
 * src/routes/onboarding-complete.routes.js
 * Unified onboarding completion + progress autosave routes
 *
 * POST  /complete  — atomic resume onboarding completion via RPC
 * PATCH /progress  — autosave onboarding step + resume_data
 * GET   /resume    — fetch current resume state
 */

const express = require('express');
const { body } = require('express-validator');

const { validate } = require('../middleware/requestValidator');
const { supabase } = require('../config/supabase');
const logger = require('../utils/logger');

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function resolveUserId(req) {
  return (
    req?.user?.id ||
    req?.user?.uid ||
    req?.auth?.userId ||
    req?.user?.user_id ||
    null
  );
}

function validateResumeData(data) {
  const missing = [];
  const improvements = [];

  if (!data?.personal_info?.name?.trim()) {
    missing.push('Full name');
  }

  if (!data?.personal_info?.email?.trim()) {
    missing.push('Email address');
  }

  if (!data?.personal_info?.phone?.trim()) {
    missing.push('Phone number');
  }

  const hasExp =
    Array.isArray(data?.experience) &&
    data.experience.length > 0;

  const hasEdu =
    Array.isArray(data?.education) &&
    data.education.length > 0;

  if (!hasExp && !hasEdu) {
    missing.push('At least one experience or education entry');
  }

  if (
    !Array.isArray(data?.skills) ||
    data.skills.length < 3
  ) {
    improvements.push('Add at least 3 skills');
  }

  if (!data?.summary?.trim()) {
    improvements.push('Add a professional summary');
  }

  if (
    hasExp &&
    data.experience.some(
      (item) => (item?.description ?? '').trim().length < 30
    )
  ) {
    improvements.push('Expand experience descriptions');
  }

  return {
    valid: missing.length === 0,
    missing,
    improvements,
  };
}

function calcProfileStrength(data) {
  let score = 0;

  if (data?.personal_info?.name?.trim())     score += 5;
  if (data?.personal_info?.email?.trim())    score += 5;
  if (data?.personal_info?.phone?.trim())    score += 5;
  if (data?.personal_info?.location?.trim()) score += 5;

  const hasExp =
    Array.isArray(data?.experience) &&
    data.experience.length > 0;

  const hasEdu =
    Array.isArray(data?.education) &&
    data.education.length > 0;

  if (hasExp) score += 15;
  if (Array.isArray(data?.experience) && data.experience.length > 1) {
    score += 5;
  }

  if (hasEdu) score += 15;

  if (Array.isArray(data?.skills) && data.skills.length >= 3) score += 10;
  if (Array.isArray(data?.skills) && data.skills.length >= 6) score += 5;

  if ((data?.summary ?? '').trim().length > 50) score += 10;

  if (Array.isArray(data?.projects) && data.projects.length > 0) score += 5;

  if (
    Array.isArray(data?.certifications) &&
    data.certifications.length > 0
  ) {
    score += 5;
  }

  return Math.min(100, score);
}

// ─────────────────────────────────────────────────────────────
// POST /complete
//
// Atomically completes onboarding via complete_resume_onboarding
// RPC — eliminates the previous SELECT → check → UPDATE race
// condition under parallel duplicate requests.
//
// RPC behaviour:
//   - Locks the user row with FOR UPDATE
//   - Returns { already_complete: true,  updated: false } if done
//   - Returns { already_complete: false, updated: true  } on success
//   - Raises exception if user not found
// ─────────────────────────────────────────────────────────────
router.post(
  '/complete',
  validate([
    body('resume_data')
      .isObject()
      .withMessage('resume_data is required'),
  ]),
  async (req, res, next) => {
    try {
      const userId = resolveUserId(req);

      if (!userId) {
        return res.status(401).json({
          success:   false,
          errorCode: 'UNAUTHORIZED',
          message:   'Authentication required.',
        });
      }

      const resumeData = req.body.resume_data;
      const { valid, missing } = validateResumeData(resumeData);

      if (!valid) {
        return res.status(422).json({
          success:   false,
          errorCode: 'VALIDATION_FAILED',
          message:   'Resume data does not meet completion requirements.',
          missing,
        });
      }

      const profileStrength = calcProfileStrength(resumeData);

      // ── Atomic RPC — single transaction, no race condition ────────
      const { data: rpcResult, error: rpcError } =
        await supabase.rpc('complete_resume_onboarding', {
          p_user_id:          userId,
          p_resume_data:      resumeData,
          p_profile_strength: profileStrength,
        });

      if (rpcError) {
        logger.error('[OnboardingComplete] RPC error', {
          userId,
          error: rpcError.message,
        });
        return next(rpcError);
      }

      // ── Already complete — idempotent response ────────────────────
      if (rpcResult?.already_complete) {
        return res.json({
          success:         true,
          alreadyComplete: true,
          profileStrength: null,
          message:         'Onboarding already complete.',
        });
      }

      logger.info('[OnboardingComplete] Onboarding marked complete', {
        userId,
        profileStrength,
      });

      return res.json({
        success:         true,
        alreadyComplete: false,
        profileStrength,
        message:         'Onboarding complete.',
      });

    } catch (error) {
      return next(error);
    }
  }
);

// ─────────────────────────────────────────────────────────────
// PATCH /progress
// Autosave onboarding step and/or resume_data draft.
// Direct update is safe here — no completion state involved,
// no race condition risk, no RPC needed.
// ─────────────────────────────────────────────────────────────
router.patch(
  '/progress',
  validate([
    body('step').optional().isString().trim(),
    body('resume_data').optional().isObject(),
  ]),
  async (req, res, next) => {
    try {
      const userId = resolveUserId(req);

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'Unauthorized',
        });
      }

      const { step, resume_data } = req.body;

      const patch = {
        updated_at: new Date().toISOString(),
      };

      if (step)        patch.onboarding_step = step;
      if (resume_data) patch.resume_data     = resume_data;

      // Nothing meaningful to patch
      if (Object.keys(patch).length === 1) {
        return res.json({
          success: true,
          message: 'Nothing to update.',
        });
      }

      const { error } = await supabase
        .from('users')
        .update(patch)
        .eq('id', userId);

      if (error) return next(error);

      return res.json({
        success: true,
        message: 'Progress saved.',
      });

    } catch (error) {
      return next(error);
    }
  }
);

// ─────────────────────────────────────────────────────────────
// GET /resume
// Fetch current resume state for the authenticated user.
// Read-only — no RPC needed.
// ─────────────────────────────────────────────────────────────
router.get('/resume', async (req, res, next) => {
  try {
    const userId = resolveUserId(req);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized',
      });
    }

    const { data, error } = await supabase
      .from('users')
      .select(
        'resume_data, onboarding_step, onboarding_completed, profile_strength'
      )
      .eq('id', userId)
      .single();

    if (error) return next(error);

    return res.json({
      success: true,
      data: {
        resume_data:          data?.resume_data          ?? null,
        onboarding_step:      data?.onboarding_step      ?? null,
        onboarding_completed: data?.onboarding_completed ?? false,
        profile_strength:     data?.profile_strength     ?? 0,
      },
    });

  } catch (error) {
    return next(error);
  }
});

module.exports = router;