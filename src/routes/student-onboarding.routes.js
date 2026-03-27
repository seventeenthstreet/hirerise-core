'use strict';

/**
 * student-onboarding.routes.js
 * Mounted at: /api/v1/student-onboarding
 *
 * PATCH /draft    — auto-save partial wizard state
 * GET   /draft    — restore draft on mount
 * POST  /complete — submit full wizard, create Student Career Profile,
 *                   set student_onboarding_complete = true on users/{uid}
 *
 * Supabase tables written:
 *   users                        — student_onboarding_complete: true
 *   user_profiles                — student career profile fields
 *   student_career_profiles      — full structured profile document
 *   student_onboarding_drafts    — draft (PATCH/GET)
 */
const { Router } = require('express');
const { body } = require('express-validator');
const { validate } = require('../middleware/requestValidator');
const { supabase } = require('../config/supabase');
const logger = require('../utils/logger');
const router = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function uid(req) {
  return req.user?.uid ?? null;
}

// ─── PATCH /draft — auto-save partial form data ───────────────────────────────

router.patch(
  '/draft',
  validate([
    body('age').optional({ nullable: true }).isInt({ min: 10, max: 30 }),
    body('grade').optional().isString().trim().isLength({ max: 100 }),
    body('country').optional().isString().trim().isLength({ max: 100 }),
    body('preferred_subjects').optional().isArray({ max: 20 }),
    body('interests').optional().isArray({ max: 10 }),
    body('strengths').optional().isObject(),
    body('career_curiosities').optional().isArray({ max: 10 }),
    body('learning_styles').optional().isArray({ max: 5 }),
    body('academic_marks').optional().isObject()
  ]),
  async (req, res, next) => {
    try {
      const userId = uid(req);
      if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

      const now = new Date().toISOString();

      const { error } = await supabase
        .from('student_onboarding_drafts')
        .upsert([{
          id: userId,
          ...req.body,
          updatedAt: now
        }]);
      if (error) throw error;

      return res.json({ success: true, data: { saved: true } });
    } catch (err) {
      return next(err);
    }
  }
);

// ─── GET /draft — restore draft ────────────────────────────────────────────────

router.get('/draft', async (req, res, next) => {
  try {
    const userId = uid(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const { data: draft } = await supabase
      .from('student_onboarding_drafts')
      .select('*')
      .eq('id', userId)
      .maybeSingle();

    // Strip internal fields before returning
    if (draft) {
      delete draft.updatedAt;
    }

    return res.json({ success: true, data: { draft: draft ?? null } });
  } catch (err) {
    return next(err);
  }
});

// ─── POST /complete — submit wizard, create profile, mark complete ─────────────

router.post(
  '/complete',
  validate([
    body('age')
      .isInt({ min: 10, max: 30 })
      .withMessage('age must be between 10 and 30'),
    body('grade')
      .isString().trim().notEmpty()
      .withMessage('grade is required'),
    body('country')
      .isString().trim().notEmpty()
      .withMessage('country is required'),
    body('preferred_subjects').optional().isArray(),
    body('interests')
      .isArray({ min: 1 })
      .withMessage('at least one interest is required'),
    body('strengths')
      .isObject()
      .withMessage('strengths must be an object'),
    body('strengths.problem_solving').isInt({ min: 1, max: 5 }),
    body('strengths.creativity').isInt({ min: 1, max: 5 }),
    body('strengths.communication').isInt({ min: 1, max: 5 }),
    body('strengths.mathematics').isInt({ min: 1, max: 5 }),
    body('strengths.leadership').isInt({ min: 1, max: 5 }),
    body('career_curiosities')
      .isArray({ min: 1 })
      .withMessage('at least one career curiosity is required'),
    body('learning_styles')
      .isArray({ min: 1 })
      .withMessage('at least one learning style is required'),
    // Issue 4 — academic marks (optional but validated if present)
    body('academic_marks').optional().isObject(),
    body('academic_marks.year_1').optional().isObject(),
    body('academic_marks.year_2').optional().isObject(),
    body('academic_marks.year_3').optional().isObject()
  ]),
  async (req, res, next) => {
    try {
      const userId = uid(req);
      if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

      const {
        age,
        grade,
        country,
        preferred_subjects = [],
        interests,
        strengths,
        career_curiosities,
        learning_styles,
        academic_marks = null
      } = req.body;

      const now = new Date().toISOString();

      // 1. Mark onboarding complete on users table
      const { error: usersError } = await supabase
        .from('users')
        .upsert([{
          id: userId,
          student_onboarding_complete: true,
          user_type: 'student',
          updatedAt: now
        }]);
      if (usersError) throw usersError;

      // 2. Update user_profiles table — read by AI engines
      const { error: profilesError } = await supabase
        .from('user_profiles')
        .upsert([{
          id: userId,
          student_onboarding_complete: true,
          studentProfile: {
            age,
            grade,
            country,
            preferred_subjects,
            interests,
            strengths,
            career_curiosities,
            learning_styles,
            academic_marks
          },
          updatedAt: now
        }]);
      if (profilesError) throw profilesError;

      // 3. Create dedicated student_career_profiles record
      const { error: careerProfileError } = await supabase
        .from('student_career_profiles')
        .upsert([{
          id: userId,
          userId,
          age,
          grade,
          country,
          preferred_subjects,
          interests,
          strengths,
          career_curiosities,
          learning_styles,
          academic_marks,
          createdAt: now,
          updatedAt: now,
          profileVersion: 1
        }]);
      if (careerProfileError) throw careerProfileError;

      // 4. Clean up draft
      const { error: draftDeleteError } = await supabase
        .from('student_onboarding_drafts')
        .delete()
        .eq('id', userId);
      if (draftDeleteError) throw draftDeleteError;

      logger.info('[StudentOnboarding] Profile created and onboarding marked complete', {
        userId,
        interests: interests?.length,
        career_curiosities: career_curiosities?.length
      });

      return res.json({
        success: true,
        data: { message: 'Student career profile created. Onboarding complete.' }
      });
    } catch (err) {
      return next(err);
    }
  }
);

// ─── GET /profile — return the student's completed career profile ──────────────

router.get('/profile', async (req, res, next) => {
  try {
    const userId = uid(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const { data: profile } = await supabase
      .from('student_career_profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle();

    if (profile) {
      // Strip internal timestamps before returning
      delete profile.createdAt;
      delete profile.updatedAt;
      delete profile.userId;
    }

    return res.json({ success: true, data: { profile: profile ?? null } });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;