'use strict';

/**
 * provisionalChi.route.js — Internal Cloud Tasks callback handler
 *
 * POST /api/v1/internal/provisional-chi
 *
 * Called by Google Cloud Tasks after triggerProvisionalChi() enqueues a task.
 * Protected by INTERNAL_SERVICE_TOKEN — NOT by auth token.
 *
 * PAYLOAD (JSON body from Cloud Tasks):
 *   { user_id: string, userTier: string, source: 'provisional-chi' }
 *
 * RESPONSE:
 *   200 — CHI calculated successfully (or gracefully skipped by rank guard)
 *   400 — Missing required fields
 *   500 — Unexpected error (Cloud Tasks will retry on 5xx)
 *
 * RETRY BEHAVIOUR:
 *   Cloud Tasks retries on any 5xx response using exponential backoff.
 *   The CHI rank guard in calculateProvisionalChi() makes retries safe —
 *   if a higher-quality snapshot already exists, it returns early without
 *   writing anything.
 *
 *   On 2xx and 4xx (non-retryable errors), Cloud Tasks does NOT retry.
 *   We return 200 even on graceful skips so Cloud Tasks doesn't keep retrying.
 *
 * NOTE ON DATA:
 *   Cloud Tasks only carries userId + userTier in the payload (lightweight).
 *   The handler fetches the full onboardingData and profileData from Firestore
 *   itself — this is intentional. Storing full profile data in a task payload
 *   would be a security risk (task payloads are stored by Google) and would
 *   break if data changed between enqueue and execution.
 */

const express = require('express');
const { db }  = require('../../config/supabase');
const { calculateProvisionalChi } = require('../../modules/careerHealthIndex/careerHealthIndex.service');
const logger  = require('../../utils/logger');

const router = express.Router();

router.post('/', async (req, res) => {
  const { userId, userTier = 'free', source } = req.body || {};

  // ── Input validation ──────────────────────────────────────────────────────
  if (!userId || typeof userId !== 'string') {
    logger.warn('[ProvisionalChi] Missing or invalid userId in task payload', { body: req.body });
    // Return 400 — non-retryable, bad task payload
    return res.status(400).json({
      success:   false,
      errorCode: 'VALIDATION_ERROR',
      message:   'userId is required and must be a string.',
    });
  }

  logger.info('[ProvisionalChi] Task received', { userId, userTier, source });

  try {
    // ── Fetch latest onboarding data from Firestore ───────────────────────
    // We fetch fresh data here rather than passing it through the task payload
    // to avoid stale data and to keep the payload small.
    const [progressSnap, profileSnap] = await Promise.all([
      db.collection('onboardingProgress').doc(userId).get(),
      db.collection('userProfiles').doc(userId).get(),
    ]);

    if (!progressSnap.exists) {
      logger.warn('[ProvisionalChi] onboardingProgress not found — skipping', { userId });
      // Return 200 — user may have been deleted, no point retrying
      return res.status(200).json({ success: true, skipped: true, reason: 'no_progress_doc' });
    }

    const onboardingData = progressSnap.data();
    const profileData    = profileSnap.exists ? profileSnap.data() : {};
    const careerReport   = onboardingData.careerReport ?? null;

    // ── Run CHI calculation ───────────────────────────────────────────────
    // The rank guard inside calculateProvisionalChi handles idempotency —
    // if a higher-quality snapshot already exists it returns early.
    const result = await calculateProvisionalChi(
      userId,
      onboardingData,
      profileData,
      careerReport,
      userTier,
    );

    if (result) {
      logger.info('[ProvisionalChi] CHI calculated successfully', {
        userId,
        chiScore:       result.chiScore,
        analysisSource: result.analysisSource,
      });
    } else {
      logger.info('[ProvisionalChi] CHI skipped by rank guard (higher quality snapshot exists)', { userId });
    }

    // Always return 200 on success or graceful skip — prevents Cloud Tasks retry
    return res.status(200).json({ success: true, skipped: !result });

  } catch (err) {
    logger.error('[ProvisionalChi] Unexpected error', { userId, error: err.message, stack: err.stack });
    // Return 500 — Cloud Tasks will retry with exponential backoff
    return res.status(500).json({
      success:   false,
      errorCode: 'INTERNAL_ERROR',
      message:   'Provisional CHI calculation failed.',
    });
  }
});

module.exports = router;








