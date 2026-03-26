'use strict';

/**
 * modules/ava-memory/routes/avaMemory.routes.js
 *
 * All routes are prefixed with /api/v1/ava-memory by server.js:
 *   app.use(`${API_PREFIX}/ava-memory`, authenticate, require('./modules/ava-memory/routes/avaMemory.routes'));
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ Method │ Path              │ Description                                 │
 * ├──────────────────────────────────────────────────────────────────────────┤
 * │ GET    │ /                 │ Retrieve memory context for current user    │
 * │ POST   │ /event            │ Track a career event (skill/resume/job)     │
 * │ POST   │ /weekly-snapshot  │ Trigger weekly snapshot for current user    │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

const express = require('express');
const { body, query } = require('express-validator');
const { validate }    = require('../../../middleware/requestValidator');
const service         = require('../services/avaMemory.service');
const logger          = require('../../../utils/logger');

const router = express.Router();

// ── GET /ava-memory ───────────────────────────────────────────────────────────
// Fetch the current user's memory context.
// Optional query param: current_score (float) — if provided, DB is synced async.

router.get(
  '/',
  validate([
    query('current_score').optional().isFloat({ min: 0, max: 100 }),
  ]),
  async (req, res, next) => {
    try {
      const userId       = req.user.uid;
      const currentScore = req.query.current_score != null
        ? parseFloat(req.query.current_score)
        : undefined;

      const context = await service.getAvaMemory(userId, currentScore);
      return res.json({ success: true, data: context });
    } catch (err) {
      logger.error('[AvaMemoryRoute] GET / failed', { err: err.message });
      next(err);
    }
  },
);

// ── POST /ava-memory/event ────────────────────────────────────────────────────
// Track a career event. Fire-and-forget on the client — returns immediately.

router.post(
  '/event',
  validate([
    body('event_type')
      .isIn(['skill_added', 'resume_improved', 'job_applied', 'score_updated'])
      .withMessage('event_type must be one of: skill_added, resume_improved, job_applied, score_updated'),
    body('count').optional().isInt({ min: 1, max: 100 }),
    body('score').optional().isFloat({ min: 0, max: 100 }),
  ]),
  async (req, res, next) => {
    try {
      const userId = req.user.uid;
      const { event_type, count, score } = req.body;

      // Respond immediately — tracking is non-blocking
      res.json({ success: true });

      // Track async (errors logged but don't bubble to client)
      service.trackEvent(userId, event_type, { count, score }).catch(err => {
        logger.warn('[AvaMemoryRoute] trackEvent background failure', { userId, event_type, err: err.message });
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /ava-memory/weekly-snapshot ─────────────────────────────────────────
// Manually trigger a weekly snapshot for the current user.
// Also called by the weekly cron (which uses service.runWeeklyCron() directly).

router.post(
  '/weekly-snapshot',
  async (req, res, next) => {
    try {
      const userId = req.user.uid;
      const result = await service.updateWeeklyMemory(userId);
      return res.json({ success: true, data: result });
    } catch (err) {
      logger.error('[AvaMemoryRoute] POST /weekly-snapshot failed', { err: err.message });
      next(err);
    }
  },
);

module.exports = router;








