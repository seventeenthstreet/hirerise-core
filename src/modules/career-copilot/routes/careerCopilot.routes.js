'use strict';

/**
 * careerCopilot.controller.js + careerCopilot.routes.js
 *
 * Combined controller + routes for the grounded Career Copilot.
 *
 * Endpoints:
 *   POST /api/v1/copilot/chat              — grounded chat (job seeker path)
 *   GET  /api/v1/copilot/welcome           — welcome message with data availability
 *   GET  /api/v1/copilot/history/:conversationId — conversation history
 *   GET  /api/v1/copilot/context           — debug: show retrieved context (dev only)
 *
 * Integration with existing advisor routes:
 *   The existing /api/v1/advisor/chat/:studentId remains UNTOUCHED for the
 *   student/education path. This Copilot serves the job-seeker path.
 *
 * Mount in server.js (one line):
 *   app.use(`${API_PREFIX}/copilot`, authenticate,
 *     require('./modules/career-copilot/careerCopilot.routes'));
 *
 * @module src/modules/career-copilot/careerCopilot.controller
 * @module src/modules/career-copilot/careerCopilot.routes
 */

// ══════════════════════════════════════════════════════════════════════════════
// CONTROLLER
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const logger          = require('../../../utils/logger');
const copilotService  = require('../careerCopilot.service');
const ragRetriever    = require('../retrieval/ragRetriever');

// ─── Response helpers ─────────────────────────────────────────────────────────

const ok   = (res, data)              => res.status(200).json({ success: true,  data });
const bad  = (res, msg, code = 400)   => res.status(code).json({ success: false, error: msg });

function _userId(req) {
  return req.user?.uid || req.user?.id || null;
}

// ─── POST /copilot/chat ───────────────────────────────────────────────────────

/**
 * Grounded chat endpoint.
 *
 * Body:
 *   message         {string}  required — user's question (1-2000 chars)
 *   conversation_id {string}  optional — pass to maintain session context
 *   force_refresh   {boolean} optional — bypass context cache (default false)
 *
 * Response:
 *   {
 *     response:          string   — AI answer (grounded in platform data)
 *     data_sources:      string[] — which engines were used
 *     confidence:        number   — 0-1 quality score
 *     data_completeness: number   — fraction of sources available
 *     signal_strength:   string   — 'high'|'medium'|'low'|'insufficient'
 *     was_grounded:      boolean
 *     refused:           boolean  — true if insufficient data
 *     conversation_id:   string   — session ID for follow-up questions
 *   }
 */
async function chat(req, res) {
  const userId = _userId(req);
  if (!userId) return bad(res, 'Unauthenticated', 401);

  // Accept both snake_case (conversation_id) and camelCase (conversationId) from the client.
  // The frontend dashboard sends conversationId; the canonical key is conversation_id.
  const {
    message,
    conversation_id: _conv_snake,
    conversationId:  _conv_camel,
    force_refresh,
  } = req.body;
  const conversation_id = _conv_snake || _conv_camel || undefined;

  if (!message || typeof message !== 'string') {
    return bad(res, '"message" is required and must be a string');
  }

  const trimmed = message.trim();
  if (trimmed.length === 0)    return bad(res, '"message" cannot be empty');
  if (trimmed.length > 2000)   return bad(res, '"message" must not exceed 2000 characters');

  // Load user name for personalised prompts
  let userName = req.user?.displayName || req.user?.name || null;

  try {
    const result = await copilotService.chat(userId, trimmed, {
      conversationId: conversation_id || undefined,
      userName,
      forceRefresh:   force_refresh === true,
    });

    ok(res, result);
  } catch (err) {
    logger.error('[CopilotController] chat error', { userId, err: err.message });
    bad(res, 'Failed to generate response. Please try again.', 500);
  }
}

// ─── GET /copilot/welcome ─────────────────────────────────────────────────────

async function welcome(req, res) {
  const userId = _userId(req);
  if (!userId) return bad(res, 'Unauthenticated', 401);

  try {
    const result = await copilotService.getWelcome(userId);
    ok(res, result);
  } catch (err) {
    logger.error('[CopilotController] welcome error', { userId, err: err.message });
    bad(res, 'Failed to load welcome message', 500);
  }
}

// ─── GET /copilot/history/:conversationId ────────────────────────────────────

async function history(req, res) {
  const userId         = _userId(req);
  const conversationId = req.params.conversationId;
  if (!userId)         return bad(res, 'Unauthenticated', 401);
  if (!conversationId) return bad(res, 'conversationId is required');

  try {
    const result = await copilotService.getHistory(userId, conversationId);
    ok(res, result);
  } catch (err) {
    bad(res, 'Failed to load history', 500);
  }
}

// ─── GET /copilot/context (dev/debug only) ────────────────────────────────────

/**
 * Returns the raw retrieved context for the authenticated user.
 * Only available in non-production environments.
 * Useful for debugging what data the Copilot has access to.
 */
async function debugContext(req, res) {
  if (process.env.NODE_ENV === 'production') {
    return bad(res, 'Not available in production', 403);
  }

  const userId = _userId(req);
  if (!userId) return bad(res, 'Unauthenticated', 401);

  try {
    const context = await ragRetriever.retrieveContext(userId, { forceRefresh: true });
    ok(res, {
      data_sources_used:  context.data_sources_used,
      data_completeness:  context.data_completeness,
      confidence_score:   context.confidence_score,
      is_sufficient:      context.is_sufficient,
      retrieval_ms:       context.retrieval_ms,
      // Summarise each source (don't expose full data in debug endpoint)
      sources_summary: {
        user_profile:            context.user_profile ? '✓' : '✗',
        chi_score:               context.chi_score    ? `✓ (${context.chi_score?.chi_score})` : '✗',
        skill_gaps:              context.skill_gaps   ? `✓ (${(context.skill_gaps?.missing_high_demand||[]).length} gaps)` : '✗',
        job_matches:             context.job_matches  ? `✓ (${(context.job_matches?.top_matches||[]).length} matches)` : '✗',
        opportunity_radar:       context.opportunity_radar ? `✓ (${(context.opportunity_radar?.emerging_opportunities||[]).length} opps)` : '✗',
        risk_analysis:           context.risk_analysis ? `✓ (${context.risk_analysis?.risk_level})` : '✗',
        salary_benchmarks:       context.salary_benchmarks ? '✓' : '✗',
        personalization_profile: context.personalization_profile ? `✓ (${context.personalization_profile?.total_events} events)` : '✗',
      },
    });
  } catch (err) {
    bad(res, 'Failed to retrieve context', 500);
  }
}

const controller = { chat, welcome, history, debugContext };

// ══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════════════════════

const { Router } = require('express');
const { body }   = require('express-validator');
const { validate } = require('../../../middleware/requestValidator');
const router = Router();

const chatValidators = [
  body('message')
    .isString().trim().notEmpty()
    .isLength({ max: 2000 })
    .withMessage('message must be a non-empty string up to 2000 characters'),
  // Accept both key spellings — snake_case is canonical, camelCase is sent by the dashboard
  body('conversation_id')
    .optional({ nullable: true })
    .isString().trim().isLength({ max: 100 }),
  body('conversationId')
    .optional({ nullable: true })
    .isString().trim().isLength({ max: 100 }),
  body('force_refresh')
    .optional({ nullable: true })
    .isBoolean(),
];

// POST /copilot/chat — grounded conversation
router.post('/chat', validate(chatValidators), controller.chat);

// GET /copilot/welcome — data-aware welcome message
router.get('/welcome', controller.welcome);

// GET /copilot/history/:conversationId — conversation history
router.get('/history/:conversationId', controller.history);

// GET /copilot/context — debug context view (non-production only)
router.get('/context', controller.debugContext);

module.exports = router;








