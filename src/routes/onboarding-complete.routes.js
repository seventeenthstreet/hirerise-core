'use strict';

/**
 * src/routes/onboarding-complete.routes.js
 *
 * Wave 1 hardened onboarding completion + progress autosave
 */

const express = require('express');
const { body } = require('express-validator');

const { validate } = require('../middleware/requestValidator');
const { supabase } = require('../config/supabase');
const logger = require('../utils/logger');

const router = express.Router();
const MAX_RESUME_JSON_SIZE = 500_000; // 500 KB soft cap

function resolveUserId(req) {
  return (
    req?.user?.id ||
    req?.user?.uid ||
    req?.auth?.userId ||
    req?.user?.user_id ||
    null
  );
}

function normalizeRpcResult(data) {
  if (!data) {
    return {
      updated: false,
      already_complete: false,
    };
  }

  const row = Array.isArray(data) ? data[0] : data;

  if (typeof row === 'boolean') {
    return {
      updated: row,
      already_complete: false,
    };
  }

  return {
    updated: Boolean(row?.updated),
    already_complete: Boolean(row?.already_complete),
  };
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

  if (!Array.isArray(data?.skills) || data.skills.length < 3) {
    improvements.push('Add at least 3 skills');
  }

  if (!data?.summary?.trim()) {
    improvements.push('Add a professional summary');
  }

  if (
    hasExp &&
    data.experience.some(
      item => (item?.description ?? '').trim().length < 30
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

  if (data?.personal_info?.name?.trim()) score += 5;
  if (data?.personal_info?.email?.trim()) score += 5;
  if (data?.personal_info?.phone?.trim()) score += 5;
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
  if (Array.isArray(data?.certifications) && data.certifications.length > 0) {
    score += 5;
  }

  return Math.min(100, score);
}

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
          success: false,
          errorCode: 'UNAUTHORIZED',
          message: 'Authentication required.',
        });
      }

      const resumeData = req.body.resume_data;
      const jsonSize = Buffer.byteLength(
        JSON.stringify(resumeData),
        'utf8'
      );

      if (jsonSize > MAX_RESUME_JSON_SIZE) {
        return res.status(413).json({
          success: false,
          errorCode: 'RESUME_TOO_LARGE',
          message: 'Resume data exceeds maximum allowed size.',
        });
      }

      const { valid, missing } = validateResumeData(resumeData);

      if (!valid) {
        return res.status(422).json({
          success: false,
          errorCode: 'VALIDATION_FAILED',
          message: 'Resume data does not meet completion requirements.',
          missing,
        });
      }

      const profileStrength = calcProfileStrength(resumeData);

      const { data, error } = await supabase.rpc(
        'complete_resume_onboarding',
        {
          p_user_id: userId,
          p_resume_data: resumeData,
          p_profile_strength: profileStrength,
        }
      );

      if (error) {
        logger.error('[OnboardingComplete] RPC failed', {
          rpc: 'complete_resume_onboarding',
          userId,
          code: error.code,
          details: error.details,
          error: error.message,
          payloadSize: jsonSize,
        });

        return next(error);
      }

      const rpcResult = normalizeRpcResult(data);

      if (!rpcResult.updated && !rpcResult.already_complete) {
        logger.error('[OnboardingComplete] Invalid RPC result', {
          userId,
          rpcResult,
        });

        return res.status(500).json({
          success: false,
          errorCode: 'ONBOARDING_COMPLETION_FAILED',
          message: 'Onboarding completion returned invalid result.',
        });
      }

      if (rpcResult.already_complete) {
        return res.json({
          success: true,
          alreadyComplete: true,
          profileStrength: null,
          message: 'Onboarding already complete.',
        });
      }

      logger.info('[OnboardingComplete] Completed', {
        userId,
        profileStrength,
      });

      return res.json({
        success: true,
        alreadyComplete: false,
        profileStrength,
        message: 'Onboarding complete.',
      });
    } catch (error) {
      return next(error);
    }
  }
);

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

      if (step) patch.onboarding_step = step;
      if (resume_data) patch.resume_data = resume_data;

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
        resume_data: data?.resume_data ?? null,
        onboarding_step: data?.onboarding_step ?? null,
        onboarding_completed: data?.onboarding_completed ?? false,
        profile_strength: data?.profile_strength ?? 0,
      },
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;