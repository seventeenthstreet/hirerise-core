'use strict';

/**
 * src/routes/internal/provisionalChi.route.js
 *
 * Internal Cloud Tasks callback handler
 * - Supabase singleton safe
 * - snake_case schema confirmed
 * - retry-safe parallel DB reads
 * - null-safe CHI execution
 * - service_role safe (RLS bypass by design)
 */

const express = require('express');
const { getClient, withRetry } = require('../../config/supabase');

const {
  calculateProvisionalChi,
} = require('../../modules/careerHealthIndex/careerHealthIndex.service');

const logger = require('../../utils/logger');

const router = express.Router();

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function stdError(res, status, errorCode, message) {
  return res.status(status).json({
    success: false,
    errorCode,
    message,
    timestamp: new Date().toISOString(),
  });
}

function getDb() {
  return getClient();
}

// ─────────────────────────────────────────────
// POST /
// Internal Cloud Tasks callback
// Requires service_role key
// ─────────────────────────────────────────────
router.post('/', async (req, res) => {
  const {
    userId,
    userTier = 'free',
    source,
  } = req.body || {};

  // Input validation
  if (!userId || typeof userId !== 'string') {
    logger.warn(
      '[ProvisionalChi] Missing or invalid userId in task payload',
      { body: req.body }
    );

    return stdError(
      res,
      400,
      'VALIDATION_ERROR',
      'userId is required and must be a string.'
    );
  }

  const db = getDb();

  logger.info('[ProvisionalChi] Task received', {
    userId,
    userTier,
    source,
  });

  try {
    // Parallel indexed reads on UNIQUE user_id
    const [
      { data: onboardingData, error: progressError },
      { data: profileData, error: profileError },
    ] = await Promise.all([
      withRetry(() =>
        db
          .from('onboarding_progress')
          .select('*')
          .eq('user_id', userId)
          .maybeSingle()
      ),
      withRetry(() =>
        db
          .from('user_profiles')
          .select('*')
          .eq('user_id', userId)
          .maybeSingle()
      ),
    ]);

    // Optional profile row — log and continue
    if (profileError) {
      logger.warn(
        '[ProvisionalChi] user_profiles fetch error — continuing',
        {
          userId,
          error: profileError.message,
        }
      );
    }

    // Required onboarding row
    if (progressError || !onboardingData) {
      logger.warn(
        '[ProvisionalChi] onboarding_progress not found — skipping',
        {
          userId,
          error: progressError?.message,
        }
      );

      return res.status(200).json({
        success: true,
        skipped: true,
        reason: 'no_progress_doc',
      });
    }

    const safeProfileData = profileData ?? {};
    const careerReport =
      onboardingData.career_report ?? null;

    const result = await calculateProvisionalChi(
      userId,
      onboardingData,
      safeProfileData,
      careerReport,
      userTier
    );

    if (result) {
      logger.info(
        '[ProvisionalChi] CHI calculated successfully',
        {
          userId,
          chiScore: result.chiScore,
          analysisSource: result.analysisSource,
        }
      );
    } else {
      logger.info(
        '[ProvisionalChi] CHI skipped by rank guard',
        {
          userId,
        }
      );
    }

    return res.status(200).json({
      success: true,
      skipped: !result,
    });
  } catch (err) {
    logger.error('[ProvisionalChi] Unexpected error', {
      userId,
      error: err?.message,
      stack: err?.stack,
    });

    return stdError(
      res,
      500,
      'INTERNAL_ERROR',
      'Provisional CHI calculation failed.'
    );
  }
});

module.exports = router;