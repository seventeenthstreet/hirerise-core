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
 * Firestore collections written:
 *   users/{uid}                  — student_onboarding_complete: true
 *   userProfiles/{uid}           — student career profile fields
 *   studentCareerProfiles/{uid}  — full structured profile document
 *   studentOnboardingDrafts/{uid}— draft (PATCH/GET)
 */

const { Router } = require('express');
const { body }   = require('express-validator');
const { validate } = require('../middleware/requestValidator');
const { db }     = require('../config/supabase');
const { FieldValue } = require('../config/supabase');
const logger     = require('../utils/logger');

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
    body('academic_marks').optional().isObject(),
  ]),
  async (req, res, next) => {
    try {
      const userId = uid(req);
      if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

      const now = FieldValue.serverTimestamp();
      await db.collection('studentOnboardingDrafts').doc(userId).set(
        { ...req.body, updatedAt: now },
        { merge: true }
      );

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

    const snap = await db.collection('studentOnboardingDrafts').doc(userId).get();
    const draft = snap.exists ? snap.data() : null;

    // Strip internal fields before returning
    if (draft) {
      delete draft.updatedAt;
    }

    return res.json({ success: true, data: { draft } });
  } catch (err) {
    return next(err);
  }
});

// ─── POST /complete — submit wizard, create profile, mark complete ─────────────

router.post(
  '/complete',
  validate([
    body('age').isInt({ min: 10, max: 30 }).withMessage('age must be between 10 and 30'),
    body('grade').isString().trim().notEmpty().withMessage('grade is required'),
    body('country').isString().trim().notEmpty().withMessage('country is required'),
    body('preferred_subjects').optional().isArray(),
    body('interests').isArray({ min: 1 }).withMessage('at least one interest is required'),
    body('strengths').isObject().withMessage('strengths must be an object'),
    body('strengths.problem_solving').isInt({ min: 1, max: 5 }),
    body('strengths.creativity').isInt({ min: 1, max: 5 }),
    body('strengths.communication').isInt({ min: 1, max: 5 }),
    body('strengths.mathematics').isInt({ min: 1, max: 5 }),
    body('strengths.leadership').isInt({ min: 1, max: 5 }),
    body('career_curiosities').isArray({ min: 1 }).withMessage('at least one career curiosity is required'),
    body('learning_styles').isArray({ min: 1 }).withMessage('at least one learning style is required'),
    // Issue 4 — academic marks (optional but validated if present)
    body('academic_marks').optional().isObject(),
    body('academic_marks.year_1').optional().isObject(),
    body('academic_marks.year_2').optional().isObject(),
    body('academic_marks.year_3').optional().isObject(),
  ]),
  async (req, res, next) => {
    try {
      const userId = uid(req);
      if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

      const {
        age, grade, country,
        preferred_subjects = [],
        interests,
        strengths,
        career_curiosities,
        learning_styles,
        academic_marks = null,
      } = req.body;

      const now   = FieldValue.serverTimestamp();
      const batch = db.batch();

      // 1. Mark onboarding complete on users/{uid}
      batch.set(db.collection('users').doc(userId), {
        student_onboarding_complete: true,
        user_type:                   'student', // ensure consistency
        updatedAt:                   now,
      }, { merge: true });

      // 2. Update userProfiles/{uid} — read by AI engines
      batch.set(db.collection('userProfiles').doc(userId), {
        student_onboarding_complete: true,
        studentProfile: {
          age, grade, country,
          preferred_subjects,
          interests,
          strengths,
          career_curiosities,
          learning_styles,
          academic_marks,
        },
        updatedAt: now,
      }, { merge: true });

      // 3. Create dedicated studentCareerProfiles/{uid} document
      batch.set(db.collection('studentCareerProfiles').doc(userId), {
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
        createdAt:   now,
        updatedAt:   now,
        profileVersion: 1,
      });

      // 4. Clean up draft
      batch.delete(db.collection('studentOnboardingDrafts').doc(userId));

      await batch.commit();

      logger.info('[StudentOnboarding] Profile created and onboarding marked complete', {
        userId,
        interests: interests?.length,
        career_curiosities: career_curiosities?.length,
      });

      return res.json({
        success: true,
        data: { message: 'Student career profile created. Onboarding complete.' },
      });
    } catch (err) {
      return next(err);
    }
  }
);

module.exports = router;

// ─── GET /profile — return the student's completed career profile ──────────────

router.get('/profile', async (req, res, next) => {
  try {
    const userId = uid(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const snap = await db.collection('studentCareerProfiles').doc(userId).get();
    const profile = snap.exists ? snap.data() : null;

    if (profile) {
      // Strip internal timestamps before returning
      delete profile.createdAt;
      delete profile.updatedAt;
      delete profile.userId;
    }

    return res.json({ success: true, data: { profile } });
  } catch (err) {
    return next(err);
  }
});









