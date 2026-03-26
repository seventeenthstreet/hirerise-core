'use strict';

/**
 * src/routes/onboarding-complete.routes.js
 *
 * POST /api/v1/onboarding/complete
 *
 * Called by the frontend when the user clicks "Confirm & Go to Dashboard"
 * on the unified review screen. Validates the submitted ResumeData, calculates
 * profile strength, persists everything to the users table, and marks
 * onboarding_completed = true.
 *
 * ONLY marks complete when:
 *   1. name, email, phone are present
 *   2. At least one experience OR one education entry exists
 *   3. (Improvements like skills < 3 are warned but don't block)
 *
 * Returns { success, profileStrength, alreadyComplete } so the frontend
 * can redirect and update its local state without a second /users/me fetch.
 *
 * PATCH /api/v1/onboarding/progress
 *
 * Called on every guided step change to auto-save partial progress.
 * Never marks onboarding_completed = true — only saves partial data.
 */

const express          = require('express');
const { createClient } = require('@supabase/supabase-js');
const logger           = require('../utils/logger');

const router = express.Router();

// ─── Supabase client ──────────────────────────────────────────────────────────

let _supabase = null;

function getDb() {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  _supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return _supabase;
}

// ─── Validation (mirrors frontend validateResume()) ───────────────────────────
// Single source of truth lives on the server — frontend duplicates it for UX.

function validateResumeData(data) {
  const missing      = [];
  const improvements = [];

  if (!data?.personal_info?.name?.trim())  missing.push('Full name');
  if (!data?.personal_info?.email?.trim()) missing.push('Email address');
  if (!data?.personal_info?.phone?.trim()) missing.push('Phone number');

  const hasExp = Array.isArray(data?.experience) && data.experience.length > 0;
  const hasEdu = Array.isArray(data?.education)  && data.education.length  > 0;
  if (!hasExp && !hasEdu) missing.push('At least one experience or education entry');

  if (!Array.isArray(data?.skills) || data.skills.length < 3)
    improvements.push('Add at least 3 skills');
  if (!data?.summary?.trim())
    improvements.push('Add a professional summary');
  if (hasExp && data.experience.some(e => (e.description ?? '').trim().length < 30))
    improvements.push('Expand experience descriptions');

  return { valid: missing.length === 0, missing, improvements };
}

// ─── Profile strength (mirrors frontend profileStrength()) ───────────────────

function calcProfileStrength(data) {
  let score = 0;
  if (data?.personal_info?.name?.trim())     score += 5;
  if (data?.personal_info?.email?.trim())    score += 5;
  if (data?.personal_info?.phone?.trim())    score += 5;
  if (data?.personal_info?.location?.trim()) score += 5;  // total personal = 20

  const hasExp = Array.isArray(data?.experience) && data.experience.length > 0;
  const hasEdu = Array.isArray(data?.education)  && data.education.length  > 0;
  if (hasExp) score += 15;
  if (Array.isArray(data?.experience) && data.experience.length > 1) score += 5; // total exp = 20

  if (hasEdu) score += 15;                                                        // total edu = 15

  if (Array.isArray(data?.skills) && data.skills.length >= 3)  score += 10;
  if (Array.isArray(data?.skills) && data.skills.length >= 6)  score += 5;       // total skills = 15

  if (data?.summary?.trim().length > 50) score += 10;                            // total summary = 10

  if (Array.isArray(data?.projects)       && data.projects.length > 0)       score += 5;
  if (Array.isArray(data?.certifications) && data.certifications.length > 0) score += 5; // total extras = 10

  return Math.min(100, score);
}

// ─── POST /api/v1/onboarding/complete ────────────────────────────────────────

router.post('/complete', async (req, res, next) => {
  try {
    const userId   = req.user.uid;
    const supabase = getDb();

    // Load current onboarding state — if already complete, return early
    const { data: current, error: fetchErr } = await supabase
      .from('users')
      .select('onboarding_completed')
      .eq('id', userId)
      .single();

    if (fetchErr) return next(fetchErr);

    if (current?.onboarding_completed) {
      return res.json({
        success:         true,
        alreadyComplete: true,
        profileStrength: null,
        message:         'Onboarding already complete.',
      });
    }

    // Validate submitted resume data
    const resumeData = req.body.resume_data;
    if (!resumeData || typeof resumeData !== 'object') {
      return res.status(400).json({
        success:   false,
        errorCode: 'INVALID_PAYLOAD',
        message:   'resume_data is required and must be an object.',
      });
    }

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

    // Persist: resume_data, profile_strength, onboarding_completed, step
    const { error: updateErr } = await supabase
      .from('users')
      .update({
        onboarding_completed: true,
        onboarding_step:      'complete',
        resume_data:          resumeData,
        profile_strength:     profileStrength,
        updated_at:           new Date().toISOString(),
      })
      .eq('id', userId);

    if (updateErr) {
      logger.error('[OnboardingComplete] Failed to update user', { userId, error: updateErr.message });
      return next(updateErr);
    }

    logger.info('[OnboardingComplete] Onboarding marked complete', { userId, profileStrength });

    return res.json({
      success:         true,
      alreadyComplete: false,
      profileStrength,
      message:         'Onboarding complete.',
    });

  } catch (err) {
    return next(err);
  }
});

// ─── PATCH /api/v1/onboarding/progress ───────────────────────────────────────
// Auto-save partial progress mid-flow. Never sets onboarding_completed = true.

router.patch('/progress', async (req, res, next) => {
  try {
    const userId      = req.user.uid;
    const supabase    = getDb();
    const { step, resume_data } = req.body;

    const patch = { updated_at: new Date().toISOString() };
    if (step)        patch.onboarding_step = step;
    if (resume_data) patch.resume_data     = resume_data;

    if (Object.keys(patch).length === 1) {
      return res.json({ success: true, message: 'Nothing to update.' });
    }

    const { error } = await supabase
      .from('users')
      .update(patch)
      .eq('id', userId);

    if (error) return next(error);

    return res.json({ success: true, message: 'Progress saved.' });

  } catch (err) {
    return next(err);
  }
});

// ─── GET /api/v1/onboarding/resume ───────────────────────────────────────────
// Returns saved partial resume_data and onboarding_step so the frontend
// can resume from where the user left off.

router.get('/resume', async (req, res, next) => {
  try {
    const userId   = req.user.uid;
    const supabase = getDb();

    const { data, error } = await supabase
      .from('users')
      .select('resume_data, onboarding_step, onboarding_completed, profile_strength')
      .eq('id', userId)
      .single();

    if (error) return next(error);

    return res.json({
      success: true,
      data: {
        resume_data:          data.resume_data          ?? null,
        onboarding_step:      data.onboarding_step      ?? null,
        onboarding_completed: data.onboarding_completed ?? false,
        profile_strength:     data.profile_strength     ?? 0,
      },
    });

  } catch (err) {
    return next(err);
  }
});

module.exports = router;








