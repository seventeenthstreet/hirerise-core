'use strict';

/**
 * routes/career-onboarding.routes.js
 * Mounted at: /api/v1/career-onboarding
 *
 * POST /complete
 * Completes professional onboarding using a single atomic Supabase RPC.
 */

const { Router } = require('express');
const { body } = require('express-validator');
const { validate } = require('../middleware/requestValidator');
const { supabase } = require('../config/supabase');
const logger = require('../utils/logger');

const router = Router();

const MAX_TEXT = 150;
const MAX_SKILLS = 20;
const MAX_EXPERIENCE = 60;

function resolveUserId(req) {
  return (
    req?.user?.id ||
    req?.user?.uid ||
    req?.auth?.userId ||
    req?.user?.user_id ||
    null
  );
}

router.post(
  '/complete',
  validate([
    body('jobTitle')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: MAX_TEXT })
      .withMessage('jobTitle is required'),

    body('yearsExperience')
      .isFloat({ min: 0, max: MAX_EXPERIENCE })
      .toFloat()
      .withMessage(
        `yearsExperience must be between 0 and ${MAX_EXPERIENCE}`
      ),

    body('industry')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: MAX_TEXT })
      .withMessage('industry is required'),

    body('educationLevel')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: MAX_TEXT })
      .withMessage('educationLevel is required'),

    body('country')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: MAX_TEXT })
      .withMessage('country is required'),

    body('city')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: MAX_TEXT })
      .withMessage('city is required'),

    body('salaryRange')
      .optional({ nullable: true })
      .isString()
      .trim()
      .isLength({ max: MAX_TEXT }),

    body('careerGoals')
      .isArray({ min: 1, max: 20 })
      .withMessage('at least one career goal is required'),

    body('skills')
      .optional()
      .isArray({ max: MAX_SKILLS })
      .withMessage(`skills must be max ${MAX_SKILLS}`),

    body('cvUploaded')
      .optional()
      .isBoolean()
      .toBoolean(),
  ]),
  async (req, res, next) => {
    try {
      const userId = resolveUserId(req);

      if (!userId) {
        return res.status(401).json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication required.',
          },
        });
      }

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
        cvUploaded = false,
      } = req.body;

      const { error } = await supabase.rpc(
        'complete_professional_onboarding',
        {
          p_user_id: userId,
          p_job_title: jobTitle,
          p_years_experience: yearsExperience,
          p_industry: industry,
          p_education_level: educationLevel,
          p_country: country,
          p_city: city,
          p_salary_range: salaryRange,
          p_career_goals: careerGoals,
          p_skills: skills,
          p_cv_uploaded: cvUploaded,
        }
      );

      if (error) throw error;

      logger.info(
        '[CareerOnboarding] Professional onboarding completed',
        {
          userId,
          jobTitle,
          industry,
          cvUploaded,
          goalsCount: careerGoals.length,
          skillsCount: skills.length,
        }
      );

      return res.status(200).json({
        success: true,
        data: {
          message:
            'Professional career profile created. Onboarding complete.',
        },
      });
    } catch (error) {
      logger.error(
        '[CareerOnboarding] Failed to complete onboarding',
        {
          userId: resolveUserId(req),
          error: error.message,
          stack: error.stack,
        }
      );

      return next(error);
    }
  }
);

module.exports = router;