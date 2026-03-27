'use strict';

/**
 * appEntry.route.js — PHASE 4 UPDATE
 *
 * FIXED: Two bugs in the cache-warming helpers:
 *
 *   1. `supabase` was never imported — the file only destructured `db` from
 *      require('../../config/supabase'), so every supabase.from() call threw
 *      ReferenceError: supabase is not defined.
 *      Fix: require the client directly as `supabase`.
 *
 *   2. _warmProfile() and the onboarding read used Firestore-style response
 *      handling: snap.exists / snap.data(). Supabase returns { data, error }.
 *      Fix: destructure { data, error } from every .select() call.
 *
 * EXISTING LOGIC (unchanged):
 *   - ensureUserSeeded()
 *   - onboardingCompleted read
 *   - syncProfileDisplayFields()
 *   - redirectTo logic
 *   - CACHE_KEYS / CACHE_TTL constants
 *   - warmUserCache() fire-and-forget pattern
 */

const express = require('express');
// FIXED: import supabase client directly (not just `db`)
const supabase = require('../../config/supabase');
const { normalizeTier } = require('../../middleware/requireTier.middleware');
const {
  ensureUserSeeded,
  syncProfileDisplayFields,
} = require('../user/user.registration.service');
const logger = require('../../utils/logger');

const router = express.Router();

// ─── Cache key constants ──────────────────────────────────────────────────────

const CACHE_KEYS = {
  userProfile: userId => `profile:${userId}`,
  chiLatest:   userId => `chi:latest:${userId}`,
};

const CACHE_TTL = {
  userProfile: 5  * 60, // 5 minutes
  chiLatest:   10 * 60, // 10 minutes
};

// ─── Cache warm helper ────────────────────────────────────────────────────────

async function warmUserCache(userId) {
  let redis;
  try {
    const mgr    = require('../../core/cache/cache.manager');
    const client = mgr.getClient();
    redis        = client?.client ?? client;
    if (!redis?.set) return;
  } catch {
    return;
  }

  await Promise.allSettled([
    _warmProfile(userId, redis),
    _warmChiLatest(userId, redis),
  ]);
}

async function _warmProfile(userId, redis) {
  try {
    // FIXED: destructure { data, error } — Supabase never returns .exists or .data()
    const { data: profile, error } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle();

    if (error || !profile) return;

    const key = CACHE_KEYS.userProfile(userId);
    await redis.set(key, JSON.stringify(profile), 'EX', CACHE_TTL.userProfile);
    logger.debug('[AppEntry] Warmed profile cache', { userId });
  } catch (err) {
    logger.debug('[AppEntry] Profile cache warm failed (non-fatal)', {
      userId,
      error: err.message,
    });
  }
}

async function _warmChiLatest(userId, redis) {
  try {
    const chiRepo = require('../careerHealthIndex/chiSnapshot.repository');
    const latest  = await chiRepo.getLatest(userId);
    if (!latest) return;

    const key = CACHE_KEYS.chiLatest(userId);
    await redis.set(key, JSON.stringify(latest), 'EX', CACHE_TTL.chiLatest);
    logger.debug('[AppEntry] Warmed CHI cache', { userId, chiScore: latest.chiScore });
  } catch (err) {
    logger.debug('[AppEntry] CHI cache warm failed (non-fatal)', {
      userId,
      error: err.message,
    });
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

    // Ensure Firestore profile docs exist
    try {
      await ensureUserSeeded(userId, req.user);
    } catch (seedErr) {
      logger.error('[AppEntry] ensureUserSeeded failed — proceeding without seed', {
        userId,
        error: seedErr.message,
      });
    }

    // Read onboarding state
    let onboardingComplete = false;
    try {
      // FIXED: destructure { data, error } — removed snap.exists / snap.data()
      const { data: profileData, error: profileError } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('id', userId)
        .maybeSingle();

      if (profileError) {
        logger.warn('[AppEntry] userProfiles read error', { userId, error: profileError.message });
      }

      const profile = profileData ?? {};
      onboardingComplete = profile.onboarding_completed === true ||
                           profile.onboardingCompleted  === true;

      syncProfileDisplayFields(userId, req.user, {
        displayName: profile.display_name  ?? profile.displayName ?? null,
        photoURL:    profile.photo_url     ?? profile.photoURL    ?? null,
      }).catch(err =>
        logger.warn('[AppEntry] Display field sync failed (non-fatal)', {
          userId,
          error: err.message,
        })
      );

      // Phase 4: cache warming — fire-and-forget, never delays response
      warmUserCache(userId).catch(() => {});
    } catch (readErr) {
      logger.warn('[AppEntry] userProfiles read failed — defaulting to onboarding', {
        userId,
        error: readErr.message,
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
module.exports.CACHE_KEYS    = CACHE_KEYS;
module.exports.CACHE_TTL     = CACHE_TTL;
module.exports.warmUserCache = warmUserCache;