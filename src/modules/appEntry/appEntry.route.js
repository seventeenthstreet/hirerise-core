'use strict';

/**
 * appEntry.route.js — PHASE 4 UPDATE
 *
 * CHANGES FROM PHASE 3:
 *
 *   1. Cache warming on login.
 *      After the user profile Firestore read, a non-blocking fire-and-forget
 *      call to warmUserCache(userId) pre-populates Redis with:
 *        - userProfiles/{userId}           → key: profile:{userId}     TTL: 5m
 *        - latest CHI snapshot (if any)    → key: chi:latest:{userId}  TTL: 10m
 *
 *      Warming is async and never delays the app-entry response.
 *      If Redis is down, warming is skipped silently.
 *      Subsequent API calls hit Redis instead of Firestore on first request.
 *
 *   2. Cache key constants co-located here for discoverability.
 *      Services that read these keys should import CACHE_KEYS from this file
 *      or from a shared constants file — never hardcode the key strings.
 *
 * EXISTING LOGIC (unchanged):
 *   - ensureUserSeeded()
 *   - onboardingCompleted read
 *   - syncProfileDisplayFields()
 *   - redirectTo logic
 */

const express = require('express');
const { db }  = require('../../config/supabase');
const { normalizeTier }                           = require('../../middleware/requireTier.middleware');
const { ensureUserSeeded, syncProfileDisplayFields } = require('../user/user.registration.service');
const logger  = require('../../utils/logger');

const router = express.Router();

// ─── Cache key constants ──────────────────────────────────────────────────────
// These are the canonical Redis keys for user-scoped warm data.
// Services that read from cache should import and use these constants.

const CACHE_KEYS = {
  userProfile: (userId) => `profile:${userId}`,
  chiLatest:   (userId) => `chi:latest:${userId}`,
};

const CACHE_TTL = {
  userProfile: 5  * 60,   // 5 minutes — profile changes infrequently
  chiLatest:   10 * 60,   // 10 minutes — CHI calc is expensive, warm for full session
};

// ─── Cache warm helper ────────────────────────────────────────────────────────

/**
 * warmUserCache(userId)
 *
 * Pre-populates Redis with the user's profile and latest CHI snapshot.
 * Non-blocking: always called as fire-and-forget from the route handler.
 * Never throws — all errors are swallowed and logged.
 *
 * @param {string} userId
 */
async function warmUserCache(userId) {
  let redis;
  try {
    const mgr    = require('../../core/cache/cache.manager');
    const client = mgr.getClient();
    // Need raw ioredis SET for TTL — check interface
    redis = client?.client ?? client;
    if (!redis?.set) return; // Memory cache or no Redis — skip
  } catch {
    return; // Cache manager unavailable
  }

  // Run both warm operations in parallel — neither blocks the other
  await Promise.allSettled([
    _warmProfile(userId, redis),
    _warmChiLatest(userId, redis),
  ]);
}

async function _warmProfile(userId, redis) {
  try {
    const snap = await db.collection('userProfiles').doc(userId).get();
    if (!snap.exists) return;

    const key  = CACHE_KEYS.userProfile(userId);
    await redis.set(key, JSON.stringify(snap.data()), 'EX', CACHE_TTL.userProfile);
    logger.debug('[AppEntry] Warmed profile cache', { userId });
  } catch (err) {
    logger.debug('[AppEntry] Profile cache warm failed (non-fatal)', { userId, error: err.message });
  }
}

async function _warmChiLatest(userId, redis) {
  try {
    // Use the sharded repo from Phase 4 (falls back to legacy automatically)
    const chiRepo = require('../careerHealthIndex/chiSnapshot.repository');
    const latest  = await chiRepo.getLatest(userId);

    if (!latest) return;

    const key = CACHE_KEYS.chiLatest(userId);
    await redis.set(key, JSON.stringify(latest), 'EX', CACHE_TTL.chiLatest);
    logger.debug('[AppEntry] Warmed CHI cache', { userId, chiScore: latest.chiScore });
  } catch (err) {
    logger.debug('[AppEntry] CHI cache warm failed (non-fatal)', { userId, error: err.message });
  }
}

// ─── Route ────────────────────────────────────────────────────────────────────

router.get('/', async (req, res, next) => {
  try {
    const userId = req.user?.uid;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const tier = normalizeTier(req.user.plan);
    req.user.normalizedTier = tier;

    // ── FIX G-02: Ensure Firestore profile docs exist ─────────────────────
    try {
      await ensureUserSeeded(userId, req.user);
    } catch (seedErr) {
      logger.error('[AppEntry] ensureUserSeeded failed — proceeding without seed', {
        userId, error: seedErr.message,
      });
    }

    // ── Read onboarding state ─────────────────────────────────────────────
    let onboardingComplete = false;
    try {
      const profileSnap  = await db.collection('userProfiles').doc(userId).get();
      const profileData  = profileSnap.exists ? profileSnap.data() : {};
      onboardingComplete = profileData?.onboardingCompleted === true;

      // FIX G-09: sync display fields
      syncProfileDisplayFields(userId, req.user, {
        displayName: profileData?.displayName ?? null,
        photoURL:    profileData?.photoURL    ?? null,
      }).catch(err =>
        logger.warn('[AppEntry] Display field sync failed (non-fatal)', { userId, error: err.message })
      );

      // ── Phase 4: cache warming — fire-and-forget ──────────────────────
      // Non-blocking: does not await. Never delays this response.
      warmUserCache(userId).catch(() => {}); // swallow all errors
    } catch (readErr) {
      logger.warn('[AppEntry] userProfiles read failed — defaulting to onboarding', {
        userId, error: readErr.message,
      });
      onboardingComplete = false;
    }

    const redirectTo = onboardingComplete ? '/dashboard' : '/onboarding';
    logger.debug('[AppEntry]', { userId, tier, onboardingComplete, redirectTo });

    return res.status(200).json({
      success: true,
      data: { onboardingComplete, tier, redirectTo },
    });

  } catch (err) {
    return next(err);
  }
});

module.exports = router;
module.exports.CACHE_KEYS = CACHE_KEYS;
module.exports.CACHE_TTL  = CACHE_TTL;
module.exports.warmUserCache = warmUserCache; // exported for manual warm triggers








