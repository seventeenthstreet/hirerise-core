'use strict';

/**
 * src/routes/userDirection.routes.js
 *
 * Intent Gateway — direction preference endpoints.
 *
 * PATCH: ETag correctness — POST /me/direction now bumps users.updated_at.
 *
 * Root cause:
 *   POST /me/direction updates users.user_direction and direction_set_at but
 *   does NOT touch users.updated_at.
 *
 *   user_direction itself is NOT in the GET /me response or the ETag token.
 *   However, setting a direction also causes the frontend to redirect to
 *   /education/onboarding, /dashboard, or /market-insights — which immediately
 *   triggers GET /me.  If the user had previously been issued an ETag and
 *   their profile data hasn't changed, GET /me would return 304 correctly.
 *
 *   The ACTUAL risk here is indirect: in future, user_type may be derived from
 *   user_direction and included in the response. More importantly, this is the
 *   gateway for first-time users choosing a direction: if user_type is written
 *   (either here or by a subsequent trigger), updated_at must change.
 *
 *   Defensive fix: always bump updated_at on direction save. The cost is one
 *   extra column in an already-executing UPDATE. No correctness risk.
 *
 * Endpoints:
 *   POST   /api/v1/users/me/direction
 *   GET    /api/v1/users/me/direction
 *   DELETE /api/v1/users/me/direction
 */

const express = require('express');
const { body } = require('express-validator');

const { supabase } = require('../config/supabase');
const { validate } = require('../middleware/requestValidator');
const { asyncHandler } = require('../utils/helpers');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const logger = require('../utils/logger');
const freshnessCache = require('../utils/freshnessCache');

const router = express.Router();

const VALID_DIRECTIONS = Object.freeze(['education', 'career', 'market']);

const DIRECTION_ROUTES = Object.freeze({
  education: '/education/onboarding',
  career: '/dashboard',
  market: '/market-insights',
});

const DIRECTION_USER_TYPE = Object.freeze({
  education: 'student',
  career:    'professional',
  market:    'market',
});

function getUserId(req) {
  const userId =
    req.user?.id ||
    req.auth?.userId ||
    req.user?.user_id ||
    req.user?.uid;

  if (!userId || typeof userId !== 'string') {
    throw new AppError('Unauthorized', ErrorCodes.UNAUTHORIZED, 401, {});
  }

  return userId;
}

function setDirectionCookie(res, direction) {
  const isProduction = process.env.NODE_ENV === 'production';
  const cookieParts = [
    `hr_direction=${direction}`,
    'Path=/',
    `Max-Age=${60 * 60 * 24 * 365}`,
    'SameSite=Lax',
    isProduction ? 'Secure' : '',
  ].filter(Boolean);
  res.setHeader('Set-Cookie', cookieParts.join('; '));
}

function clearDirectionCookie(res) {
  res.setHeader('Set-Cookie', 'hr_direction=; Path=/; Max-Age=0; SameSite=Lax');
}

// ─────────────────────────────────────────────────────────────
// POST /me/direction
// ─────────────────────────────────────────────────────────────
router.post(
  '/me/direction',
  validate([
    body('direction')
      .isIn(VALID_DIRECTIONS)
      .withMessage(`direction must be one of: ${VALID_DIRECTIONS.join(', ')}`),
  ]),
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const { direction } = req.body;

    const { data, error } = await supabase
      .from('users')
      .update({
        user_direction: direction,
        direction_set_at: new Date().toISOString(),
        // ── FIX: write user_type alongside user_direction ──────────────────
        // GET /me reads user_type directly from the users table. The direction
        // route had a DIRECTION_USER_TYPE mapping but never wrote it to the DB,
        // so GET /me always returned user_type: null after direction selection.
        // This caused the requireDirection guard on every downstream page to
        // bounce the user back to /direction — an infinite redirect loop.
        user_type: DIRECTION_USER_TYPE[direction],
        // ── END FIX ────────────────────────────────────────────────────────
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId)
      .select('user_direction, user_type, direction_set_at')
      .maybeSingle();

    if (error) {
      throw new AppError(error.message, ErrorCodes.INTERNAL_ERROR, 500, { code: error.code });
    }

    if (!data) {
      throw new AppError(`User ${userId} not found`, ErrorCodes.NOT_FOUND, 404, {});
    }

    logger.info('[IntentGateway] Direction saved', { userId, direction });

    // ── CACHE INVALIDATION FIX ─────────────────────────────────────────────
    // The GET /me route uses a short-TTL (5s) in-memory freshnessCache to avoid
    // hitting Supabase on every request. It builds an ETag from updated_at +
    // onboarding flags and returns 304 when matched.
    //
    // BUG: This route bumps updated_at in the DB (correct), but never called
    // freshnessCache.del(). So the next GET /me within the 5s TTL window hit
    // the stale cache entry (old updated_at), generated the same ETag as the
    // client's If-None-Match header, and returned 304 with no body.
    // The frontend received no user_type update — guards kept redirecting to
    // /direction, creating an infinite redirect loop.
    //
    // FIX: Explicitly evict both cache entries for this user so the very next
    // GET /me performs a full Supabase query and returns fresh data with the
    // updated user_type.
    freshnessCache.del(`user-me:${userId}`);
    freshnessCache.del(`app-entry:${userId}`);
    // ── END CACHE INVALIDATION FIX ────────────────────────────────────────

    setDirectionCookie(res, direction);

    return res.status(200).json({
      success: true,
      data: {
        direction:  data.user_direction,
        savedAt:    data.direction_set_at,
        redirectTo: DIRECTION_ROUTES[direction],
        userType:   DIRECTION_USER_TYPE[direction],
      },
    });
  }),
);

// ─────────────────────────────────────────────────────────────
// GET /me/direction
// ─────────────────────────────────────────────────────────────
router.get(
  '/me/direction',
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);

    const { data, error } = await supabase
      .from('users')
      .select('user_direction, direction_set_at')
      .eq('id', userId)
      .maybeSingle();

    if (error) {
      throw new AppError(error.message, ErrorCodes.INTERNAL_ERROR, 500, { code: error.code });
    }

    return res.status(200).json({
      success: true,
      data: {
        direction: data?.user_direction || null,
        savedAt:   data?.direction_set_at || null,
      },
    });
  }),
);

// ─────────────────────────────────────────────────────────────
// DELETE /me/direction
// ─────────────────────────────────────────────────────────────
router.delete(
  '/me/direction',
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);

    const { data, error } = await supabase
      .from('users')
      .update({
        user_direction: null,
        // FIX: also clear user_type so GET /me reflects the reset state.
        // Without this, user_type stays set to the old direction's type (e.g.
        // 'student'), the direction/page.tsx guard sees user_type != null and
        // skips rendering the selector, causing a redirect loop back to /direction.
        user_type: null,
        direction_reset_at: new Date().toISOString(),
        // Bump updated_at on reset too for symmetry with the SET path.
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId)
      .select('direction_reset_at')
      .maybeSingle();

    if (error) {
      throw new AppError(error.message, ErrorCodes.INTERNAL_ERROR, 500, { code: error.code });
    }

    if (!data) {
      throw new AppError(`User ${userId} not found`, ErrorCodes.NOT_FOUND, 404, {});
    }

    // FIX: evict freshness cache — mirrors the POST path.
    // Without this, the next GET /me within the 5s TTL window hits the stale
    // cache entry, generates the same ETag, and returns 304 with no body.
    // The frontend never sees the cleared user_type, so guards keep redirecting
    // to /direction even though the user is back at the direction page.
    freshnessCache.del(`user-me:${userId}`);
    freshnessCache.del(`app-entry:${userId}`);

    clearDirectionCookie(res);
    logger.info('[IntentGateway] Direction reset', { userId });

    return res.status(200).json({
      success: true,
      data: { direction: null, resetAt: data.direction_reset_at },
    });
  }),
);

module.exports = router;