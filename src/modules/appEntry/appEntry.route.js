'use strict';

/**
 * src/modules/appEntry/appEntry.route.js
 *
 * PATCH: Early-304 short-circuit for GET /app-entry
 *
 *   Before this patch:
 *     authenticate → ensureUserSeeded() → fetchUserProfile() (Supabase)
 *     → syncProfileDisplayFields() → warmUserCache() (2× more Supabase calls)
 *     → res.json() → Express hashes full body → 304
 *
 *   After this patch:
 *     authenticate → lightweight freshness query (onboarding_completed + updated_at)
 *     → build ETag → compare If-None-Match
 *     → return 304 immediately if matched  (no seed, no warm, no sync)
 *     → ONLY THEN: ensureUserSeeded + fetchUserProfile + warmUserCache
 *
 *   ETag freshness token:
 *     `v1:<sha256-16>` over { onboarding_completed, updated_at, plan }
 *     - onboarding_completed — the only field this route returns that can change
 *     - updated_at           — catches any other profile mutation
 *     - plan                 — from the already-verified JWT claim; free
 */

const express = require('express');
const crypto  = require('crypto');
const { supabase } = require('../../config/supabase');
const { normalizeTier } = require('../../middleware/requireTier.middleware');
const {
  ensureUserSeeded,
  syncProfileDisplayFields,
} = require('../user/user.registration.service');
const chiSnapshotRepository = require(
  '../careerHealthIndex/chiSnapshot.repository'
);
const logger = require('../../utils/logger');

const freshnessCache = require('../../utils/freshnessCache');

const router = express.Router();

const CACHE_KEYS = Object.freeze({
  userProfile: userId => `profile:${userId}`,
  chiLatest: userId => `chi:latest:${userId}`,
});

const CACHE_TTL = Object.freeze({
  userProfile: 5 * 60,
  chiLatest: 10 * 60,
});

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
      .select(`id,display_name,photo_url,onboarding_completed,updated_at`)
      .eq('id', userId)
      .maybeSingle();
    if (error || !data) return;
    await redis.set(
      CACHE_KEYS.userProfile(userId),
      JSON.stringify(mapUserProfile(data)),
      'EX',
      CACHE_TTL.userProfile
    );
  } catch (err) {
    logger.debug('[AppEntry] Profile cache warm failed', { userId, err: err.message });
  }
}

async function warmChiLatestCache(userId, redis) {
  try {
    const latest = await chiSnapshotRepository.getLatest(userId);
    if (!latest) return;
    await redis.set(
      CACHE_KEYS.chiLatest(userId),
      JSON.stringify(latest),
      'EX',
      CACHE_TTL.chiLatest
    );
  } catch (err) {
    logger.debug('[AppEntry] CHI cache warm failed', { userId, err: err.message });
  }
}

async function fetchUserProfile(userId) {
  // IMPORTANT: query ONLY snake_case columns that exist in user_profiles.
  const { data, error } = await supabase
    .from('user_profiles')
    .select(`id,display_name,photo_url,onboarding_completed,updated_at`)
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    logger.warn('[AppEntry] Profile read error', { userId, err: error.message });
    return null;
  }
  return data ? mapUserProfile(data) : null;
}

function mapUserProfile(row) {
  return {
    id:                  row.id,
    displayName:         row.display_name ?? null,
    photoURL:            row.photo_url ?? null,
    onboardingCompleted: row.onboarding_completed ?? false,
    updatedAt:           row.updated_at ?? null,
  };
}

// ─────────────────────────────────────────────────────────────
// ETag helpers  ── NEW
// ─────────────────────────────────────────────────────────────

/**
 * Lightweight freshness query for /app-entry.
 *
 * user_profiles.onboarding_completed and updated_at are sufficient because:
 *   - The only response field that changes after first-login is
 *     onboardingComplete (and the derived redirectTo).
 *   - updated_at captures any other profile mutation.
 *   - tier/plan comes from the already-cached JWT claim — no extra query.
 *
 * Returns null on error or missing row; caller falls through to full work.
 */
async function fetchAppEntryFreshnessMetadata(userId) {
  const cacheKey = `app-entry:${userId}`;

  // Phase 2 warm-path: check bounded in-memory cache before Supabase query.
  const cached = freshnessCache.get(cacheKey);
  if (cached !== null) {
    return cached;
  }

  try {
    // FIX: Query 'users' table (not 'user_profiles') and include user_type/user_direction.
    // Direction routes write to 'users' and bust this cache key. If we query
    // 'user_profiles', its updated_at never changes on direction save — the ETag
    // matches and returns stale 304, leaving user_type null indefinitely.
    const { data, error } = await supabase
      .from('users')
      .select('onboarding_completed,updated_at,user_type,user_direction')
      .eq('id', userId)
      .maybeSingle();

    if (error) {
      logger.warn('[AppEntry] Freshness metadata query failed', { userId, err: error.message });
      return null;
    }

    // Only cache a valid non-null result — failed / empty queries must not
    // poison the cache.
    if (data !== null && data !== undefined) {
      freshnessCache.set(cacheKey, data);
    }

    return data ?? null;
  } catch (err) {
    logger.warn('[AppEntry] Freshness metadata exception', { userId, err: err.message });
    return null;
  }
}

/**
 * Build a deterministic ETag for the /app-entry response.
 *
 * Inputs:
 *   meta — from fetchAppEntryFreshnessMetadata()
 *   plan — normalized tier string from the JWT claim
 */
function buildAppEntryETag(meta, plan) {
  const canonical = JSON.stringify({
    v: 2, // bumped: added user_type + user_direction to invalidate stale client ETags
    o: meta.onboarding_completed ?? false,
    u: meta.updated_at ?? '',
    p: plan ?? 'free',
    // FIX: include direction fields so a direction save (which changes these
    // values and bumps updated_at) always produces a different ETag,
    // preventing a false 304 that would leave user_type null in the client.
    ut: meta.user_type ?? null,
    ud: meta.user_direction ?? null,
  });
  const hash = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return `"v1:${hash}"`;
}

function isETagMatch(generatedETag, ifNoneMatchHeader) {
  if (!ifNoneMatchHeader) return false;
  return ifNoneMatchHeader.replace(/^W\//, '').trim() === generatedETag;
}

// ─────────────────────────────────────────────────────────────
// GET /app-entry
// ─────────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const userId = req.user?.uid;

    if (!userId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Unauthorized.' }, meta: { timestamp: new Date().toISOString() } });
    }

    const tier         = normalizeTier(req.user?.plan);
    const normalizedTier = tier;

    // ── EARLY-304 SHORT-CIRCUIT ────────────────────────────────────────
    // Auth already verified. Fetch ONLY onboarding_completed + updated_at
    // from user_profiles — a single narrow query.  If the client's ETag
    // still matches, return 304 immediately; skip seed, sync, and warm.
    const meta = await fetchAppEntryFreshnessMetadata(userId);

    if (meta !== null) {
      const etag = buildAppEntryETag(meta, tier);

      if (isETagMatch(etag, req.headers['if-none-match'])) {
        logger.debug('[AppEntry] early 304', { userId });
        res.set('ETag', etag);
        return res.status(304).end();
      }

      // ETag mismatch — attach to 200 response built below.
      res.set('ETag', etag);
    }
    // ── END EARLY-304 ─────────────────────────────────────────────────

    // ── FULL WORK (only runs when data has actually changed) ───────────

    try {
      await ensureUserSeeded(userId, { ...req.user, normalizedTier });
    } catch (err) {
      logger.warn('[AppEntry] Seed failed', { userId, err: err.message });
    }

    let onboardingComplete = false;

    try {
      const profile = (await fetchUserProfile(userId)) || {};
      onboardingComplete = profile.onboardingCompleted === true;

      Promise.resolve(
        syncProfileDisplayFields(userId, req.user, {
          displayName: profile.displayName ?? null,
          photoURL:    profile.photoURL ?? null,
        })
      ).catch(err => {
        logger.debug('[AppEntry] Display sync skipped', { userId, err: err.message });
      });

      warmUserCache(userId).catch(() => {});
    } catch (err) {
      logger.warn('[AppEntry] Profile fetch failed', { userId, err: err.message });
    }

    const redirectTo = onboardingComplete ? '/dashboard' : '/onboarding';

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
module.exports.CACHE_TTL = CACHE_TTL;
module.exports.warmUserCache = warmUserCache;