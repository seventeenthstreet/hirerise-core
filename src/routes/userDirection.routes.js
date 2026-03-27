'use strict';

/**
 * src/routes/userDirection.routes.js
 *
 * Intent Gateway — direction preference endpoints.
 *
 * Endpoints:
 *   POST   /api/v1/users/me/direction  → save direction
 *   GET    /api/v1/users/me/direction  → read current direction
 *   DELETE /api/v1/users/me/direction  → reset direction
 *
 * Mounted in server.js AFTER users.routes.js on the same /api/v1/users prefix.
 * Does NOT modify any existing file.
 */
const express = require('express');
const {
  body
} = require('express-validator');
const supabase = require('../config/supabase');
const {
  validate
} = require('../middleware/requestValidator');
const logger = require('../utils/logger');
const router = express.Router();
const VALID_DIRECTIONS = ['education', 'career', 'market'];
const DIRECTION_ROUTES = {
  education: '/education/onboarding',
  career: '/dashboard',
  market: '/market-insights'
};

// ─── POST /me/direction ───────────────────────────────────────────────────────
router.post('/me/direction', validate([body('direction').isIn(VALID_DIRECTIONS).withMessage(`direction must be one of: ${VALID_DIRECTIONS.join(', ')}`)]), async (req, res, next) => {
  const uid = req.user.uid;
  const {
    direction
  } = req.body;
  try {
    const { data: existingUser, error: fetchError } = await supabase
      .from('users')
      .select('id')
      .eq('id', uid)
      .maybeSingle();

    if (fetchError) throw fetchError;

    if (!existingUser) {
      return res.status(404).json({
        success: false,
        errorCode: 'USER_NOT_FOUND',
        message: `User ${uid} not found.`
      });
    }

    const now = new Date().toISOString();
    const { error: updateError } = await supabase
      .from('users')
      .update({
        user_direction: direction,
        direction_set_at: now,
        updatedAt: now
      })
      .eq('id', uid);

    if (updateError) throw updateError;

    logger.info({
      uid,
      direction
    }, '[IntentGateway] Direction saved');
    const isProduction = process.env.NODE_ENV === 'production';
    const cookieParts = [`hr_direction=${direction}`, `Path=/`, `Max-Age=${60 * 60 * 24 * 365}`, `SameSite=Lax`, isProduction ? 'Secure' : ''].filter(Boolean);
    res.setHeader('Set-Cookie', cookieParts.join('; '));
    return res.status(200).json({
      success: true,
      data: {
        direction,
        savedAt: now,
        redirectTo: DIRECTION_ROUTES[direction]
      }
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /me/direction ────────────────────────────────────────────────────────
router.get('/me/direction', async (req, res, next) => {
  const uid = req.user.uid;
  try {
    const { data, error } = await supabase
      .from('users')
      .select('user_direction, direction_set_at')
      .eq('id', uid)
      .maybeSingle();

    if (error) throw error;

    const direction = data?.user_direction ?? null;
    const savedAt = data?.direction_set_at
      ? typeof data.direction_set_at === 'string'
        ? data.direction_set_at
        : new Date(data.direction_set_at).toISOString()
      : null;

    return res.status(200).json({
      success: true,
      data: {
        direction,
        savedAt
      }
    });
  } catch (err) {
    next(err);
  }
});

// ─── DELETE /me/direction ─────────────────────────────────────────────────────
router.delete('/me/direction', async (req, res, next) => {
  const uid = req.user.uid;
  try {
    const now = new Date().toISOString();
    const { error } = await supabase
      .from('users')
      .update({
        user_direction: null,
        direction_reset_at: now,
        updatedAt: now
      })
      .eq('id', uid);

    if (error) throw error;

    res.setHeader('Set-Cookie', 'hr_direction=; Path=/; Max-Age=0; SameSite=Lax');
    logger.info({
      uid
    }, '[IntentGateway] Direction reset');
    return res.status(200).json({
      success: true,
      data: {
        direction: null,
        resetAt: now
      }
    });
  } catch (err) {
    next(err);
  }
});
module.exports = router;