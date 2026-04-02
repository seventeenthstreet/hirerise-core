'use strict';

/**
 * provisionalChi.route.js — Internal Cloud Tasks callback handler
 */

const express = require('express');
const { supabase } = require('../../config/supabase'); // ✅ FIXED
const {
  calculateProvisionalChi
} = require('../../modules/careerHealthIndex/careerHealthIndex.service');
const logger = require('../../utils/logger');

const router = express.Router();

router.post('/', async (req, res) => {
  const {
    userId,
    userTier = 'free',
    source
  } = req.body || {};

  // ── Input validation ──────────────────────────────────────────────────────
  if (!userId || typeof userId !== 'string') {
    logger.warn('[ProvisionalChi] Missing or invalid userId in task payload', {
      body: req.body
    });

    return res.status(400).json({
      success: false,
      errorCode: 'VALIDATION_ERROR',
      message: 'userId is required and must be a string.'
    });
  }

  logger.info('[ProvisionalChi] Task received', {
    userId,
    userTier,
    source
  });

  try {
    // ── Fetch data from Supabase ────────────────────────────────────────────
    const [
      { data: onboardingData, error: progressError },
      { data: profileData, error: profileError }
    ] = await Promise.all([
      supabase
        .from('onboardingProgress')
        .select('*')
        .eq('id', userId) // ⚠️ change to 'user_id' if needed
        .single(),

      supabase
        .from('userProfiles')
        .select('*')
        .eq('id', userId) // ⚠️ change to 'user_id' if needed
        .single()
    ]);

    // ── Handle onboarding data missing ──────────────────────────────────────
    if (progressError || !onboardingData) {
      logger.warn('[ProvisionalChi] onboardingProgress not found — skipping', {
        userId,
        error: progressError?.message
      });

      return res.status(200).json({
        success: true,
        skipped: true,
        reason: 'no_progress_doc'
      });
    }

    // profileData can be null → safe fallback
    const safeProfileData = profileData || {};
    const careerReport = onboardingData.careerReport ?? null;

    // ── Run CHI calculation ───────────────────────────────────────────────
    const result = await calculateProvisionalChi(
      userId,
      onboardingData,
      safeProfileData,
      careerReport,
      userTier
    );

    if (result) {
      logger.info('[ProvisionalChi] CHI calculated successfully', {
        userId,
        chiScore: result.chiScore,
        analysisSource: result.analysisSource
      });
    } else {
      logger.info('[ProvisionalChi] CHI skipped by rank guard', {
        userId
      });
    }

    return res.status(200).json({
      success: true,
      skipped: !result
    });

  } catch (err) {
    logger.error('[ProvisionalChi] Unexpected error', {
      userId,
      error: err.message,
      stack: err.stack
    });

    return res.status(500).json({
      success: false,
      errorCode: 'INTERNAL_ERROR',
      message: 'Provisional CHI calculation failed.'
    });
  }
});

module.exports = router;