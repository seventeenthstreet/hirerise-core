'use strict';

/**
 * career-onboarding.routes.js
 * Mounted at: /api/v1/career-onboarding
 *
 * POST /complete — submit professional wizard payload, create Professional
 *                  Career Profile, set professional_onboarding_complete = true
 *
 * Note: CV upload (Step 1) is handled by the existing
 *   POST /api/v1/onboarding/upload-cv endpoint (multer route).
 * Draft auto-save (Steps 2–5) uses PATCH /api/v1/onboarding/draft.
 * Both existing routes are reused without modification.
 *
 * Supabase tables written:
 *   users                        — professional_onboarding_complete: true, resumeUploaded
 *   user_profiles                — professional career profile fields
 *   professional_career_profiles — full structured profile document
 */
const { Router } = require('express');
const { body } = require('express-validator');
const { validate } = require('../middleware/requestValidator');
const { supabase } = require('../config/supabase');
const logger = require('../utils/logger');
const router = Router();

function uid(req) {
  return req.user?.uid ?? null;
}

// ─── POST /complete ────────────────────────────────────────────────────────────

router.post(
  '/complete',
  validate([
    body('jobTitle')
      .isString().trim().notEmpty().isLength({ max: 150 })
      .withMessage('jobTitle is required'),
    body('yearsExperience')
      .isFloat({ min: 0, max: 60 })
      .withMessage('yearsExperience must be a positive number'),
    body('industry')
      .isString().trim().notEmpty()
      .withMessage('industry is required'),
    body('educationLevel')
      .isString().trim().notEmpty()
      .withMessage('educationLevel is required'),
    body('country')
      .isString().trim().notEmpty()
      .withMessage('country is required'),
    body('city')
      .isString().trim().notEmpty()
      .withMessage('city is required'),
    body('salaryRange')
      .optional({ nullable: true }).isString().trim(),
    body('careerGoals')
      .isArray({ min: 1 })
      .withMessage('at least one career goal is required'),
    body('skills')
      .optional().isArray({ max: 20 }),
    body('cvUploaded')
      .optional().isBoolean()
  ]),
  async (req, res, next) => {
    try {
      const userId = uid(req);
      if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

      const {
        jobTitle,
        yearsExperience,
        industry,
        educationLevel,
        country,
        city,
        salaryRange = null,
        careerGoals = [],
        skills = [],
        cvUploaded = false
      } = req.body;

      const now = new Date().toISOString();

      // 1. Mark onboarding complete on users table
      const { error: usersError } = await supabase
        .from('users')
        .upsert([{
          id: userId,
          professional_onboarding_complete: true,
          user_type: 'professional',
          resumeUploaded: cvUploaded,
          targetRole: jobTitle,
          experienceYears: parseFloat(yearsExperience),
          location: `${city}, ${country}`,
          updatedAt: now
        }]);
      if (usersError) throw usersError;

      // 2. Update user_profiles table — read by AI engines (CHI, Skill Gap, etc.)
      const { error: profilesError } = await supabase
        .from('user_profiles')
        .upsert([{
          id: userId,
          professional_onboarding_complete: true,
          professionalProfile: {
            jobTitle,
            yearsExperience: parseFloat(yearsExperience),
            industry,
            educationLevel,
            country,
            city,
            salaryRange,
            careerGoals,
            skills,
            cvUploaded
          },
          skills,
          targetRole: jobTitle,
          experienceYears: parseFloat(yearsExperience),
          updatedAt: now
        }]);
      if (profilesError) throw profilesError;

      // 3. Create dedicated professional_career_profiles record
      const { error: careerProfileError } = await supabase
        .from('professional_career_profiles')
        .upsert([{
          id: userId,
          userId,
          jobTitle,
          yearsExperience: parseFloat(yearsExperience),
          industry,
          educationLevel,
          country,
          city,
          salaryRange,
          careerGoals,
          skills,
          cvUploaded,
          createdAt: now,
          updatedAt: now,
          profileVersion: 1
        }]);
      if (careerProfileError) throw careerProfileError;

      logger.info(
        '[CareerOnboarding] Professional profile created and onboarding marked complete',
        {
          userId,
          jobTitle,
          industry,
          cvUploaded,
          goalsCount: careerGoals.length,
          skillsCount: skills.length
        }
      );

      return res.json({
        success: true,
        data: { message: 'Professional career profile created. Onboarding complete.' }
      });
    } catch (err) {
      return next(err);
    }
  }
);

module.exports = router;