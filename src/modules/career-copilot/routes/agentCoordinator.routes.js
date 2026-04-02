'use strict';

/**
 * @file src/modules/career-copilot/routes/agentCoordinator.routes.js
 * @description
 * Production-grade Multi-Agent Copilot API routes.
 *
 * Optimized for:
 * - Supabase-safe row queries
 * - consistent response envelopes
 * - route-level validation hygiene
 * - safer query builder flow
 * - logging consistency
 * - better maintainability
 */

const { Router } = require('express');
const { body, query: qv } = require('express-validator');

const { validate } = require('../../../middleware/requestValidator');
const logger = require('../../../utils/logger');
const coordinator = require('../coordinator/careerAgentCoordinator');
const { supabase } = require('../../../config/supabase');

const router = Router();

const MAX_MESSAGE_LENGTH = 2000;
const MAX_SESSION_ID_LENGTH = 100;
const DEFAULT_HISTORY_LIMIT = 10;
const MAX_HISTORY_LIMIT = 30;

// ─────────────────────────────────────────────────────────────────────────────
// Response helpers
// ─────────────────────────────────────────────────────────────────────────────
function ok(res, data) {
  res.set('Cache-Control', 'no-store');
  return res.status(200).json({
    success: true,
    data,
  });
}

function bad(res, message, code = 400) {
  res.set('Cache-Control', 'no-store');
  return res.status(code).json({
    success: false,
    error: message,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth helper
// ─────────────────────────────────────────────────────────────────────────────
function getUserId(req) {
  return req.user?.id || req.user?.uid || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared validators
// ─────────────────────────────────────────────────────────────────────────────
const sessionIdValidator = body('session_id')
  .optional({ nullable: true })
  .isString()
  .trim()
  .isLength({ max: MAX_SESSION_ID_LENGTH });

const forceRefreshValidator = body('force_refresh')
  .optional({ nullable: true })
  .isBoolean()
  .toBoolean();

// ─────────────────────────────────────────────────────────────────────────────
// POST /copilot/agent/ask
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/agent/ask',
  validate([
    body('message')
      .isString()
      .trim()
      .notEmpty()
      .isLength({ max: MAX_MESSAGE_LENGTH })
      .withMessage(
        `message is required (string, max ${MAX_MESSAGE_LENGTH} chars)`
      ),
    sessionIdValidator,
    forceRefreshValidator,
  ]),
  async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return bad(res, 'Unauthenticated', 401);

    const { message, session_id, force_refresh } = req.body;

    try {
      const result = await coordinator.coordinate(userId, message, {
        forceRefresh: force_refresh === true,
        sessionId: session_id || undefined,
      });

      return ok(res, result);
    } catch (err) {
      logger.error('[AgentRoute] ask error', {
        userId,
        error: err.message,
      });

      return bad(res, 'Agent routing failed. Please try again.', 500);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /copilot/agent/analyze
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/agent/analyze',
  validate([sessionIdValidator, forceRefreshValidator]),
  async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return bad(res, 'Unauthenticated', 401);

    try {
      const result = await coordinator.coordinate(userId, null, {
        forceRefresh: req.body.force_refresh === true,
        sessionId: req.body.session_id || undefined,
        agentSubset: [
          'skill',
          'jobs',
          'market',
          'risk',
          'opportunity',
        ],
      });

      return ok(res, result);
    } catch (err) {
      logger.error('[AgentRoute] analyze error', {
        userId,
        error: err.message,
      });

      return bad(res, 'Full analysis failed. Please try again.', 500);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /copilot/agent/status
// ─────────────────────────────────────────────────────────────────────────────
router.get('/agent/status', async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return bad(res, 'Unauthenticated', 401);

  try {
    const status = await coordinator.getAgentStatus();
    return ok(res, status);
  } catch (err) {
    logger.error('[AgentRoute] status error', {
      userId,
      error: err.message,
    });

    return bad(res, 'Failed to get agent status', 500);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /copilot/agent/cache/clear
// ─────────────────────────────────────────────────────────────────────────────
router.post('/agent/cache/clear', async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return bad(res, 'Unauthenticated', 401);

  try {
    await coordinator.invalidateUserCache(userId);
    return ok(res, { invalidated: true });
  } catch (err) {
    logger.error('[AgentRoute] cache clear error', {
      userId,
      error: err.message,
    });

    return bad(res, 'Cache clear failed', 500);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /copilot/agent/history
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/agent/history',
  validate([
    qv('limit')
      .optional()
      .isInt({ min: 1, max: MAX_HISTORY_LIMIT })
      .toInt()
      .withMessage(`limit must be 1–${MAX_HISTORY_LIMIT}`),
    qv('session_id')
      .optional()
      .isString()
      .trim()
      .isLength({ max: MAX_SESSION_ID_LENGTH }),
  ]),
  async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return bad(res, 'Unauthenticated', 401);

    const limit = Math.min(
      Number(req.query.limit) || DEFAULT_HISTORY_LIMIT,
      MAX_HISTORY_LIMIT
    );

    const sessionId =
      typeof req.query.session_id === 'string'
        ? req.query.session_id
        : null;

    try {
      let query = supabase
        .from('agent_responses')
        .select(
          'id, session_id, turn_index, user_query, intent, agents_used, confidence, duration_ms, created_at'
        )
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (sessionId) {
        query = query.eq('session_id', sessionId);
      }

      const { data, error } = await query;
      if (error) throw error;

      return ok(res, {
        history: data || [],
        total: Array.isArray(data) ? data.length : 0,
      });
    } catch (err) {
      logger.error('[AgentRoute] history error', {
        userId,
        error: err.message,
      });

      return bad(res, 'Failed to load agent history', 500);
    }
  }
);

module.exports = router;