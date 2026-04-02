'use strict';

/**
 * modules/ava-memory/routes/avaMemory.routes.js
 *
 * Production-ready routes for Ava Memory
 * Mounted at:
 *   /api/v1/ava-memory
 */

const express = require('express');
const { body, query } = require('express-validator');
const { validate } = require('../../../middleware/requestValidator');
const service = require('../services/avaMemory.service');
const logger = require('../../../utils/logger');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /
// Fetch current user's memory context
// Optional: current_score for async sync
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/',
  validate([
    query('current_score')
      .optional()
      .isFloat({ min: 0, max: 100 })
      .withMessage('current_score must be between 0 and 100'),
  ]),
  async (req, res, next) => {
    try {
      const userId = req.user.uid;
      const currentScore =
        req.query.current_score !== undefined
          ? Number(req.query.current_score)
          : undefined;

      const context = await service.getAvaMemory(userId, currentScore);

      return res.status(200).json({
        success: true,
        data: context,
      });
    } catch (err) {
      logger.error('[AvaMemoryRoute] GET / failed', {
        userId: req.user?.uid,
        error: err.message,
      });
      return next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /event
// Non-blocking event ingestion endpoint
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/event',
  validate([
    body('event_type')
      .isIn([
        'skill_added',
        'resume_improved',
        'job_applied',
        'score_updated',
      ])
      .withMessage(
        'event_type must be one of: skill_added, resume_improved, job_applied, score_updated'
      ),
    body('count')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('count must be between 1 and 100'),
    body('score')
      .optional()
      .isFloat({ min: 0, max: 100 })
      .withMessage('score must be between 0 and 100'),
  ]),
  async (req, res, next) => {
    try {
      const userId = req.user.uid;
      const { event_type, count, score } = req.body;

      // respond instantly
      res.status(202).json({
        success: true,
        message: 'Event accepted',
      });

      // async tracking
      Promise.resolve()
        .then(() =>
          service.trackEvent(userId, event_type, {
            count,
            score,
          })
        )
        .catch((err) => {
          logger.warn('[AvaMemoryRoute] trackEvent background failure', {
            userId,
            event_type,
            error: err.message,
          });
        });
    } catch (err) {
      logger.error('[AvaMemoryRoute] POST /event failed', {
        userId: req.user?.uid,
        error: err.message,
      });
      return next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /weekly-snapshot
// Manual trigger for current user
// ─────────────────────────────────────────────────────────────────────────────
router.post('/weekly-snapshot', async (req, res, next) => {
  try {
    const userId = req.user.uid;
    const result = await service.updateWeeklyMemory(userId);

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    logger.error('[AvaMemoryRoute] POST /weekly-snapshot failed', {
      userId: req.user?.uid,
      error: err.message,
    });
    return next(err);
  }
});

module.exports = router;