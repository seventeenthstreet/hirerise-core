'use strict';

/**
 * agentCoordinator.routes.js — Multi-Agent Copilot API
 *
 * Mounts on the existing /copilot prefix — additive, does NOT replace
 * the existing RAG chat endpoints (/copilot/chat, /copilot/welcome).
 *
 * Mount in server.js (one line — place after the existing copilot route):
 *
 *   app.use(`${API_PREFIX}/copilot`, authenticate,
 *     require('./modules/career-copilot/routes/agentCoordinator.routes'));
 *
 * Endpoints:
 *
 *   POST /api/v1/copilot/agent/ask          — question-driven routing
 *   POST /api/v1/copilot/agent/analyze      — full analysis (all agents)
 *   GET  /api/v1/copilot/agent/status       — agent registry + health
 *   POST /api/v1/copilot/agent/cache/clear  — invalidate user's agent caches
 *   GET  /api/v1/copilot/agent/history      — recent agent response history
 *
 * File location: src/modules/career-copilot/routes/agentCoordinator.routes.js
 *
 * @module src/modules/career-copilot/routes/agentCoordinator.routes
 */

'use strict';

const { Router }   = require('express');
const { body, query: qv } = require('express-validator');
const { validate } = require('../../../middleware/requestValidator');
const logger        = require('../../../utils/logger');
const coordinator   = require('../coordinator/careerAgentCoordinator');
const supabase      = require('../../../core/supabaseClient');

const router = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ok  = (res, data)            => res.status(200).json({ success: true,  data });
const bad = (res, msg, code = 400) => res.status(code).json({ success: false, error: msg });

function _uid(req) {
  return req.user?.uid || req.user?.id || null;
}

// ─── POST /copilot/agent/ask ─────────────────────────────────────────────────

/**
 * Question-driven agent routing.
 * Coordinator classifies the intent, selects relevant agents, returns answer.
 *
 * Body:
 *   message       {string}  required — user question (max 2000 chars)
 *   session_id    {string}  optional — keep multi-turn context
 *   force_refresh {boolean} optional — bypass caches (default false)
 *
 * Response includes:
 *   skills_to_learn, job_matches, career_risk, opportunities,
 *   ai_recommendation, agents_used, intent_detected, confidence
 */
router.post('/agent/ask',
  validate([
    body('message')
      .isString().trim().notEmpty().isLength({ max: 2000 })
      .withMessage('message is required (string, max 2000 chars)'),
    body('session_id')
      .optional({ nullable: true })
      .isString().trim().isLength({ max: 100 }),
    body('force_refresh')
      .optional({ nullable: true })
      .isBoolean().toBoolean(),
  ]),
  async (req, res) => {
    const userId = _uid(req);
    if (!userId) return bad(res, 'Unauthenticated', 401);

    const { message, session_id, force_refresh } = req.body;

    try {
      const result = await coordinator.coordinate(userId, message, {
        forceRefresh: force_refresh === true,
        sessionId:    session_id   || undefined,
      });
      ok(res, result);
    } catch (err) {
      logger.error('[AgentRoute] ask error', { userId, err: err.message });
      bad(res, 'Agent routing failed. Please try again.', 500);
    }
  }
);

// ─── POST /copilot/agent/analyze ─────────────────────────────────────────────

/**
 * Full analysis — runs all five specialist agents regardless of query.
 * Use for: dashboard load, post-CV-upload, manual "refresh analysis" button.
 *
 * Body:
 *   session_id    {string}  optional
 *   force_refresh {boolean} optional
 *
 * Returns the same shape as /ask but with all five agents populated.
 */
router.post('/agent/analyze',
  validate([
    body('session_id')
      .optional({ nullable: true })
      .isString().trim().isLength({ max: 100 }),
    body('force_refresh')
      .optional({ nullable: true })
      .isBoolean().toBoolean(),
  ]),
  async (req, res) => {
    const userId = _uid(req);
    if (!userId) return bad(res, 'Unauthenticated', 401);

    try {
      const result = await coordinator.coordinate(userId, null, {
        forceRefresh: req.body.force_refresh === true,
        sessionId:    req.body.session_id    || undefined,
        agentSubset:  ['skill', 'jobs', 'market', 'risk', 'opportunity'], // all five
      });
      ok(res, result);
    } catch (err) {
      logger.error('[AgentRoute] analyze error', { userId, err: err.message });
      bad(res, 'Full analysis failed. Please try again.', 500);
    }
  }
);

// ─── GET /copilot/agent/status ───────────────────────────────────────────────

/**
 * Returns agent registry + intent routing map.
 * Useful for dashboard UI showing which agents are active.
 */
router.get('/agent/status', async (req, res) => {
  const userId = _uid(req);
  if (!userId) return bad(res, 'Unauthenticated', 401);

  try {
    const status = await coordinator.getAgentStatus();
    ok(res, status);
  } catch (err) {
    bad(res, 'Failed to get agent status', 500);
  }
});

// ─── POST /copilot/agent/cache/clear ─────────────────────────────────────────

/**
 * Invalidate all agent + coordinator caches for the authenticated user.
 * Call this after CV upload or profile update to force fresh agent runs.
 */
router.post('/agent/cache/clear', async (req, res) => {
  const userId = _uid(req);
  if (!userId) return bad(res, 'Unauthenticated', 401);

  try {
    await coordinator.invalidateUserCache(userId);
    ok(res, { invalidated: true });
  } catch (err) {
    bad(res, 'Cache clear failed', 500);
  }
});

// ─── GET /copilot/agent/history ──────────────────────────────────────────────

/**
 * Returns the user's recent agent response history from Supabase.
 *
 * Query params:
 *   limit      {number} — max results (default 10, max 30)
 *   session_id {string} — filter by session
 */
router.get('/agent/history',
  validate([
    qv('limit')
      .optional()
      .isInt({ min: 1, max: 30 }).toInt()
      .withMessage('limit must be 1–30'),
    qv('session_id')
      .optional()
      .isString().trim().isLength({ max: 100 }),
  ]),
  async (req, res) => {
    const userId    = _uid(req);
    if (!userId) return bad(res, 'Unauthenticated', 401);

    const limit     = Math.min(parseInt(req.query.limit) || 10, 30);
    const sessionId = req.query.session_id || null;

    try {
      let q = supabase
        .from('agent_responses')
        .select('id, session_id, turn_index, user_query, intent, agents_used, confidence, duration_ms, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (sessionId) q = q.eq('session_id', sessionId);

      const { data, error } = await q;
      if (error) throw new Error(error.message);

      ok(res, { history: data || [], total: (data || []).length });
    } catch (err) {
      logger.error('[AgentRoute] history error', { userId, err: err.message });
      bad(res, 'Failed to load agent history', 500);
    }
  }
);

module.exports = router;









