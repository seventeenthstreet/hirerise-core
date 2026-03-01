'use strict';

/**
 * appEntry.route.js
 *
 * GET /api/v1/app-entry
 *
 * The SINGLE authority that tells the frontend where to send the user.
 * Frontend MUST rely only on this endpoint for post-auth routing.
 *
 * FIX G-02: ensureUserSeeded() is now called on every app-entry request.
 *   This guarantees that both users/{uid} and userProfiles/{uid} exist in
 *   Firestore BEFORE the user ever touches the onboarding flow.
 *
 *   Without this fix, Track A's persistCompletionIfReady() would read a
 *   non-existent userProfiles doc → evaluateCompletion sees trackB=false →
 *   onboardingCompleted is never written, even after both tracks complete.
 *
 *   ensureUserSeeded is idempotent (set merge:true) — safe to call on every
 *   request. Fast-path exits immediately if both docs already exist.
 *
 * Logic:
 *   1. Seed users/{uid} + userProfiles/{uid} if not yet present (G-02 fix)
 *   2. Read onboardingCompleted from userProfiles/{userId}
 *   3. Read tier from req.user.plan (custom claim — NEVER Firestore)
 *
 * Response:
 *   {
 *     onboardingComplete: boolean,
 *     tier: string,
 *     redirectTo: "/onboarding" | "/dashboard"
 *   }
 *
 * Registration in server.js:
 *   app.use(`${API_PREFIX}/app-entry`, authenticate, require('./modules/appEntry/appEntry.route'));
 */

const express  = require('express');
const { db }   = require('../../config/firebase');
const { normalizeTier }   = require('../../middleware/requireTier.middleware');
const { ensureUserSeeded, syncProfileDisplayFields } = require('../user/user.registration.service');
const logger   = require('../../utils/logger');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const userId = req.user?.uid;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    // Tier comes from Firebase custom claim only — no Firestore
    const tier = normalizeTier(req.user.plan);
    // Attach for downstream middleware reuse
    req.user.normalizedTier = tier;

    // ── FIX G-02: Ensure Firestore profile docs exist ────────────────────────
    // Must run BEFORE reading onboardingCompleted — guarantees userProfiles/{uid}
    // exists so Track A's persistCompletionIfReady works correctly.
    // Idempotent — fast no-op if both docs already present.
    try {
      await ensureUserSeeded(userId, req.user);
    } catch (seedErr) {
      // Non-fatal — log and continue. Seeding failure should not block app access.
      logger.error('[AppEntry] ensureUserSeeded failed — proceeding without seed', {
        userId,
        error: seedErr.message,
      });
    }

    // Single Firestore read for completion state + G-09 display field sync
    let onboardingComplete = false;
    try {
      const profileSnap   = await db.collection('userProfiles').doc(userId).get();
      const profileData   = profileSnap.exists ? profileSnap.data() : {};
      onboardingComplete  = profileData?.onboardingCompleted === true;

      // FIX G-09: sync displayName/photoURL from Firebase token → Firestore.
      // diff-guarded — only writes when token values differ from stored values.
      // Runs after ensureUserSeeded so the doc is guaranteed to exist.
      syncProfileDisplayFields(userId, req.user, {
        displayName: profileData?.displayName ?? null,
        photoURL:    profileData?.photoURL    ?? null,
      }).catch(err =>
        logger.warn('[AppEntry] Display field sync failed (non-fatal)', { userId, error: err.message })
      );
    } catch (readErr) {
      // Safe default: send to onboarding if we can't read
      logger.warn('[AppEntry] userProfiles read failed — defaulting to onboarding', { userId, error: readErr.message });
      onboardingComplete = false;
    }

    const redirectTo = onboardingComplete ? '/dashboard' : '/onboarding';

    logger.debug('[AppEntry]', { userId, tier, onboardingComplete, redirectTo });

    return res.status(200).json({
      success: true,
      data: {
        onboardingComplete,
        tier,
        redirectTo,
      },
    });

  } catch (err) {
    return next(err);
  }
});

module.exports = router;