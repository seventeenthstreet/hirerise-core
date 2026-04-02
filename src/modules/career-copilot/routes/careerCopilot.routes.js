'use strict';

/**
 * @file src/modules/career-copilot/careerCopilot.routes.js
 * @description
 * Production-grade controller + routes for grounded Career Copilot.
 *
 * Optimized for:
 * - low-latency route handling
 * - consistent response envelopes
 * - safer auth extraction
 * - debug endpoint hardening
 * - future abort propagation readiness
 */

const { Router } = require('express');
const { body, param } = require('express-validator');

const logger = require('../../../utils/logger');
const { validate } = require('../../../middleware/requestValidator');

const copilotService = require('../careerCopilot.service');
const ragRetriever = require('../retrieval/ragRetriever');

const router = Router();

const MAX_MESSAGE_LENGTH = 2000;
const MAX_CONVERSATION_ID_LENGTH = 100;

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
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function normalizeConversationId(body = {}) {
  return (
    body.conversation_id ||
    body.conversationId ||
    undefined
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /copilot/chat
// ─────────────────────────────────────────────────────────────────────────────
async function chat(req, res) {
  const userId = getUserId(req);
  if (!userId) return bad(res, 'Unauthenticated', 401);

  const rawMessage = req.body?.message;

  if (typeof rawMessage !== 'string') {
    return bad(res, '"message" is required and must be a string');
  }

  const message = rawMessage.trim();

  if (!message) {
    return bad(res, '"message" cannot be empty');
  }

  if (message.length > MAX_MESSAGE_LENGTH) {
    return bad(
      res,
      `"message" must not exceed ${MAX_MESSAGE_LENGTH} characters`
    );
  }

  const conversationId = normalizeConversationId(req.body);

  const userName =
    req.user?.displayName ||
    req.user?.name ||
    null;

  let clientDisconnected = false;
  req.on('close', () => {
    clientDisconnected = true;
  });

  try {
    const result = await copilotService.chat(userId, message, {
      conversationId,
      userName,
      forceRefresh: req.body?.force_refresh === true,
      signal: req.signal, // future abort propagation ready
    });

    if (clientDisconnected) {
      logger.warn('[CopilotController] Client disconnected before response', {
        userId,
      });
      return;
    }

    return ok(res, result);
  } catch (err) {
    logger.error('[CopilotController] chat error', {
      userId,
      error: err.message,
    });

    return bad(res, 'Failed to generate response. Please try again.', 500);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /copilot/welcome
// ─────────────────────────────────────────────────────────────────────────────
async function welcome(req, res) {
  const userId = getUserId(req);
  if (!userId) return bad(res, 'Unauthenticated', 401);

  try {
    const result = await copilotService.getWelcome(userId);
    return ok(res, result);
  } catch (err) {
    logger.error('[CopilotController] welcome error', {
      userId,
      error: err.message,
    });

    return bad(res, 'Failed to load welcome message', 500);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /copilot/history/:conversationId
// ─────────────────────────────────────────────────────────────────────────────
async function history(req, res) {
  const userId = getUserId(req);
  const conversationId = req.params?.conversationId;

  if (!userId) return bad(res, 'Unauthenticated', 401);
  if (!conversationId) {
    return bad(res, 'conversationId is required');
  }

  try {
    const result = await copilotService.getHistory(
      userId,
      conversationId
    );

    return ok(res, result);
  } catch (err) {
    logger.error('[CopilotController] history error', {
      userId,
      conversationId,
      error: err.message,
    });

    return bad(res, 'Failed to load history', 500);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /copilot/context (dev only)
// ─────────────────────────────────────────────────────────────────────────────
async function debugContext(req, res) {
  if (process.env.NODE_ENV === 'production') {
    return bad(res, 'Not available in production', 403);
  }

  const userId = getUserId(req);
  if (!userId) return bad(res, 'Unauthenticated', 401);

  try {
    const context = await ragRetriever.retrieveContext(userId, {
      forceRefresh: true,
    });

    return ok(res, {
      data_sources_used: context.data_sources_used,
      data_completeness: context.data_completeness,
      confidence_score: context.confidence_score,
      is_sufficient: context.is_sufficient,
      retrieval_ms: context.retrieval_ms,
      sources_summary: {
        user_profile: context.user_profile ? '✓' : '✗',
        chi_score: context.chi_score
          ? `✓ (${context.chi_score?.chi_score})`
          : '✗',
        skill_gaps: context.skill_gaps
          ? `✓ (${(context.skill_gaps?.missing_high_demand || []).length} gaps)`
          : '✗',
        job_matches: context.job_matches
          ? `✓ (${(context.job_matches?.top_matches || []).length} matches)`
          : '✗',
        opportunity_radar: context.opportunity_radar
          ? `✓ (${(context.opportunity_radar?.emerging_opportunities || []).length} opps)`
          : '✗',
        risk_analysis: context.risk_analysis
          ? `✓ (${context.risk_analysis?.risk_level})`
          : '✗',
        salary_benchmarks: context.salary_benchmarks ? '✓' : '✗',
        personalization_profile: context.personalization_profile
          ? `✓ (${context.personalization_profile?.total_events || 0} events)`
          : '✗',
      },
    });
  } catch (err) {
    logger.error('[CopilotController] context debug error', {
      userId,
      error: err.message,
    });

    return bad(res, 'Failed to retrieve context', 500);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Validators
// ─────────────────────────────────────────────────────────────────────────────
const chatValidators = [
  body('message')
    .isString()
    .trim()
    .notEmpty()
    .isLength({ max: MAX_MESSAGE_LENGTH })
    .withMessage(
      `message must be a non-empty string up to ${MAX_MESSAGE_LENGTH} characters`
    ),

  body('conversation_id')
    .optional({ nullable: true })
    .isString()
    .trim()
    .isLength({ max: MAX_CONVERSATION_ID_LENGTH }),

  body('conversationId')
    .optional({ nullable: true })
    .isString()
    .trim()
    .isLength({ max: MAX_CONVERSATION_ID_LENGTH }),

  body('force_refresh')
    .optional({ nullable: true })
    .isBoolean()
    .toBoolean(),
];

const historyValidators = [
  param('conversationId')
    .isString()
    .trim()
    .isLength({ min: 1, max: MAX_CONVERSATION_ID_LENGTH }),
];

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────
router.post('/chat', validate(chatValidators), chat);
router.get('/welcome', welcome);
router.get('/history/:conversationId', validate(historyValidators), history);
router.get('/context', debugContext);

module.exports = router;