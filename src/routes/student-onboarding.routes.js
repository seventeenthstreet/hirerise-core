'use strict';

/**
 * routes/student-onboarding.routes.js
 * Mounted at: /api/v1/student-onboarding
 *
 * FINAL production version
 * - RPC transaction-safe
 * - DB-owned updated_at
 * - singleton standardized
 */

const { Router } = require('express');
const { body } = require('express-validator');

const { validate } = require('../middleware/requestValidator');
const { asyncHandler } = require('../utils/helpers');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const supabase = require('../lib/supabaseClient');
const logger = require('../utils/logger');

const router = Router();

const MAX_ARRAY_10 = 10;
const MAX_ARRAY_20 = 20;
const MAX_ARRAY_5 = 5;

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

function buildStudentProfile(payload) {
  return {
    age: payload.age,
    grade: payload.grade,
    country: payload.country,
    preferred_subjects: payload.preferred_subjects || [],
    interests: payload.interests || [],
    strengths: payload.strengths || {},
    career_curiosities: payload.career_curiosities || [],
    learning_styles: payload.learning_styles || [],
    academic_marks: payload.academic_marks || null,
  };
}

// PATCH /draft
router.patch(
  '/draft',
  validate([
    body('age').optional({ nullable: true }).isInt({ min: 10, max: 30 }),
    body('grade').optional().isString().trim().isLength({ max: 100 }),
    body('country').optional().isString().trim().isLength({ max: 100 }),
    body('preferred_subjects').optional().isArray({ max: MAX_ARRAY_20 }),
    body('interests').optional().isArray({ max: MAX_ARRAY_10 }),
    body('strengths').optional().isObject(),
    body('career_curiosities').optional().isArray({ max: MAX_ARRAY_10 }),
    body('learning_styles').optional().isArray({ max: MAX_ARRAY_5 }),
    body('academic_marks').optional().isObject(),
  ]),
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);

    const { error } = await supabase
      .from('student_onboarding_drafts')
      .upsert(
        {
          user_id: userId,
          ...req.body,
        },
        { onConflict: 'user_id' },
      );

    if (error) {
      throw new AppError(
        error.message,
        500,
        { code: error.code },
        ErrorCodes.INTERNAL_ERROR,
      );
    }

    return res.status(200).json({
      success: true,
      data: { saved: true },
    });
  }),
);

// GET /draft
router.get(
  '/draft',
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);

    const { data, error } = await supabase
      .from('student_onboarding_drafts')
      .select(
        'age,grade,country,preferred_subjects,interests,strengths,career_curiosities,learning_styles,academic_marks',
      )
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

    return res.status(200).json({
      success: true,
      data: { draft: data || null },
    });
  }),
);

// POST /complete
router.post(
  '/complete',
  validate([
    body('age').isInt({ min: 10, max: 30 }),
    body('grade').isString().trim().notEmpty(),
    body('country').isString().trim().notEmpty(),
    body('preferred_subjects').optional().isArray(),
    body('interests').isArray({ min: 1 }),
    body('strengths').isObject(),
    body('strengths.problem_solving').isInt({ min: 1, max: 5 }),
    body('strengths.creativity').isInt({ min: 1, max: 5 }),
    body('strengths.communication').isInt({ min: 1, max: 5 }),
    body('strengths.mathematics').isInt({ min: 1, max: 5 }),
    body('strengths.leadership').isInt({ min: 1, max: 5 }),
    body('career_curiosities').isArray({ min: 1 }),
    body('learning_styles').isArray({ min: 1 }),
    body('academic_marks').optional().isObject(),
  ]),
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const studentProfile = buildStudentProfile(req.body);

    const { error } = await supabase.rpc(
      'complete_student_onboarding',
      {
        p_user_id: userId,
        p_profile: studentProfile,
      },
    );

    if (error) {
      throw new AppError(
        error.message,
        500,
        { code: error.code, hint: error.hint },
        ErrorCodes.INTERNAL_ERROR,
      );
    }

    logger.info(
      '[StudentOnboarding] Profile created and onboarding completed',
      {
        userId,
        interests: studentProfile.interests.length,
        curiosities: studentProfile.career_curiosities.length,
      },
    );

    return res.status(200).json({
      success: true,
      data: {
        message:
          'Student career profile created. Onboarding complete.',
      },
    });
  }),
);

// GET /profile
router.get(
  '/profile',
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);

    const { data, error } = await supabase
      .from('student_career_profiles')
      .select(
        'age,grade,country,preferred_subjects,interests,strengths,career_curiosities,learning_styles,academic_marks,profile_version',
      )
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

    return res.status(200).json({
      success: true,
      data: { profile: data || null },
    });
  }),
);

module.exports = router;