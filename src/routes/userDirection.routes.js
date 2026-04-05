'use strict';

/**
 * src/routes/userDirection.routes.js
 *
 * Intent Gateway — direction preference endpoints.
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

const router = express.Router();

const VALID_DIRECTIONS = Object.freeze([
  'education',
  'career',
  'market',
]);

const DIRECTION_ROUTES = Object.freeze({
  education: '/education/onboarding',
  career: '/dashboard',
  market: '/market-insights',
});

function getUserId(req) {
  const userId =
    req.user?.id ||
    req.auth?.userId ||
    req.user?.user_id ||
    req.user?.uid;

  if (!userId || typeof userId !== 'string') {
    throw new AppError(
      'Unauthorized',
      401,
      {},
      ErrorCodes.UNAUTHORIZED,
    );
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
  res.setHeader(
    'Set-Cookie',
    'hr_direction=; Path=/; Max-Age=0; SameSite=Lax',
  );
}

// ─────────────────────────────────────────────────────────────
// POST /me/direction
// ─────────────────────────────────────────────────────────────
router.post(
  '/me/direction',
  validate([
    body('direction')
      .isIn(VALID_DIRECTIONS)
      .withMessage(
        `direction must be one of: ${VALID_DIRECTIONS.join(', ')}`,
      ),
  ]),
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const { direction } = req.body;

    const { data, error } = await supabase
      .from('users')
      .update({
        user_direction: direction,
        direction_set_at: new Date().toISOString(),
      })
      .eq('id', userId)
      .select('user_direction, direction_set_at')
      .maybeSingle();

    if (error) {
      throw new AppError(
        error.message,
        500,
        { code: error.code },
        ErrorCodes.INTERNAL_ERROR,
      );
    }

    if (!data) {
      throw new AppError(
        `User ${userId} not found`,
        404,
        {},
        ErrorCodes.NOT_FOUND,
      );
    }

    logger.info('[IntentGateway] Direction saved', {
      userId,
      direction,
    });

    setDirectionCookie(res, direction);

    return res.status(200).json({
      success: true,
      data: {
        direction: data.user_direction,
        savedAt: data.direction_set_at,
        redirectTo: DIRECTION_ROUTES[direction],
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
      throw new AppError(
        error.message,
        500,
        { code: error.code },
        ErrorCodes.INTERNAL_ERROR,
      );
    }

    return res.status(200).json({
      success: true,
      data: {
        direction: data?.user_direction || null,
        savedAt: data?.direction_set_at || null,
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
        direction_reset_at: new Date().toISOString(),
      })
      .eq('id', userId)
      .select('direction_reset_at')
      .maybeSingle();

    if (error) {
      throw new AppError(
        error.message,
        500,
        { code: error.code },
        ErrorCodes.INTERNAL_ERROR,
      );
    }

    if (!data) {
      throw new AppError(
        `User ${userId} not found`,
        404,
        {},
        ErrorCodes.NOT_FOUND,
      );
    }

    clearDirectionCookie(res);

    logger.info('[IntentGateway] Direction reset', {
      userId,
    });

    return res.status(200).json({
      success: true,
      data: {
        direction: null,
        resetAt: data.direction_reset_at,
      },
    });
  }),
);

module.exports = router;