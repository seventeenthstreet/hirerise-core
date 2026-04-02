'use strict';

const express = require('express');
const { supabase } = require('../../config/supabase');
const { normalizeTier } = require('../../middleware/requireTier.middleware');
const {
  ensureUserSeeded,
  syncProfileDisplayFields,
} = require('../user/user.registration.service');
const logger = require('../../utils/logger');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// Cache Keys / TTL
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_KEYS = Object.freeze({
  userProfile: userId => `profile:${userId}`,
  chiLatest: userId => `chi:latest:${userId}`,
});

const CACHE_TTL = Object.freeze({
  userProfile: 5 * 60,
  chiLatest: 10 * 60,
});

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function getRedisClient() {
  try {
    const mgr = require('../../core/cache/cache.manager');
    const client = mgr.getClient();
    return client?.client ?? client ?? null;
  } catch {
    return null;
  }
}

async function warmUserCache(userId) {
  const redis = getRedisClient();
  if (!redis?.set || !userId) return;

  await Promise.allSettled([
    warmProfileCache(userId, redis),
    warmChiLatestCache(userId, redis),
  ]);
}

async function warmProfileCache(userId, redis) {
  try {
    const { data, error } = await supabase
      .from('user_profiles')
      .select(
        `
          id,
          display_name,
          photo_url,
          onboarding_completed,
          updated_at
        `
      )
      .eq('id', userId)
      .maybeSingle();

    if (error || !data) return;

    await redis.set(
      CACHE_KEYS.userProfile(userId),
      JSON.stringify(data),
      'EX',
      CACHE_TTL.userProfile
    );
  } catch (err) {
    logger.debug('[AppEntry] Profile cache warm failed', {
      userId,
      err: err.message,
    });
  }
}

async function warmChiLatestCache(userId, redis) {
  try {
    const chiRepo = require('../careerHealthIndex/chiSnapshot.repository');
    const latest = await chiRepo.getLatest(userId);
    if (!latest) return;

    await redis.set(
      CACHE_KEYS.chiLatest(userId),
      JSON.stringify(latest),
      'EX',
      CACHE_TTL.chiLatest
    );
  } catch (err) {
    logger.debug('[AppEntry] CHI cache warm failed', {
      userId,
      err: err.message,
    });
  }
}

async function fetchUserProfile(userId) {
  const { data, error } = await supabase
    .from('user_profiles')
    .select(
      `
        id,
        display_name,
        photo_url,
        onboarding_completed,
        onboardingCompleted
      `
    )
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    logger.warn('[AppEntry] Profile read error', {
      userId,
      err: error.message,
    });
    return null;
  }

  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Route
// ─────────────────────────────────────────────────────────────────────────────

router.get('/', async (req, res, next) => {
  try {
    const userId = req.user?.uid;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    const tier = normalizeTier(req.user?.plan);
    req.user.normalizedTier = tier;

    // Safe seed for Supabase-only architecture
    try {
      await ensureUserSeeded(userId, req.user);
    } catch (err) {
      logger.warn('[AppEntry] Seed failed', {
        userId,
        err: err.message,
      });
    }

    let onboardingComplete = false;

    try {
      const profile = (await fetchUserProfile(userId)) || {};

      onboardingComplete =
        profile.onboarding_completed === true ||
        profile.onboardingComplete === true ||
        profile.onboardingCompleted === true;

      // Non-blocking profile sync
      Promise.resolve(
        syncProfileDisplayFields(userId, req.user, {
          displayName:
            profile.display_name ?? profile.displayName ?? null,
          photoURL: profile.photo_url ?? profile.photoURL ?? null,
        })
      ).catch(err => {
        logger.debug('[AppEntry] Display sync skipped', {
          userId,
          err: err.message,
        });
      });

      // Non-blocking cache warm
      warmUserCache(userId).catch(() => {});
    } catch (err) {
      logger.warn('[AppEntry] Profile fetch failed', {
        userId,
        err: err.message,
      });
    }

    const redirectTo = onboardingComplete
      ? '/dashboard'
      : '/onboarding';

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
module.exports.CACHE_KEYS = CACHE_KEYS;
module.exports.CACHE_TTL = CACHE_TTL;
module.exports.warmUserCache = warmUserCache;
