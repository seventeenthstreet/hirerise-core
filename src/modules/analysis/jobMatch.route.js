'use strict';

/**
 * jobMatch.route.js
 *
 * POST /api/v1/analyze/job
 *
 * Handles both free (rule-based) and premium (AI) JD analysis.
 * operationType determines which premium engine runs.
 *
 * Body:
 * {
 *   resumeId:        string   (required)
 *   jobDescription:  string   (required, min 50 chars)
 *   operationType:   string   (optional, default: 'jobMatchAnalysis')
 *                             'jobMatchAnalysis' | 'jobSpecificCV'
 *   personalDetails: object   (optional, used for jobSpecificCV)
 * }
 *
 * Free users: operationType is ignored — always runs free engine.
 * Pro users:  operationType determines credit cost.
 *             creditGuard uses 'jobMatchAnalysis' as minimum cost guard.
 *             Service validates actual operationType before deduction.
 */

const express  = require('express');
const { authenticate }  = require('../../middleware/auth.middleware');
const { creditGuard }   = require('../../middleware/creditGuard.middleware');
const { runJobMatch }   = require('./jobMatch.service');
const { normalizeTier } = require('../../middleware/requireTier.middleware');
const aiUsageService    = require('../../services/aiUsage.service');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

const router = express.Router();

const VALID_OPERATIONS = ['jobMatchAnalysis', 'jobSpecificCV'];

router.post(
  '/job',
  authenticate,
  creditGuard('jobMatchAnalysis'), // minimum guard — jobSpecificCV costs more, checked in service
  async (req, res, next) => {
    try {
      const userId = req.user.uid;
      const tier   = req.user.normalizedTier ?? normalizeTier(req.user.plan);
      const {
        resumeId,
        jobDescription,
        operationType  = 'jobMatchAnalysis',
        personalDetails,
      } = req.body;

      if (!resumeId) {
        return next(new AppError('resumeId is required.', 400, {}, ErrorCodes.VALIDATION_ERROR));
      }

      if (!jobDescription) {
        return next(new AppError('jobDescription is required.', 400, {}, ErrorCodes.VALIDATION_ERROR));
      }

      if (!VALID_OPERATIONS.includes(operationType)) {
        return next(new AppError(
          `Invalid operationType. Must be one of: ${VALID_OPERATIONS.join(', ')}`,
          400, {}, ErrorCodes.VALIDATION_ERROR
        ));
      }

      // ── AI monthly hard-cap check ──────────────────────────────────────
      await aiUsageService.checkAndIncrement(userId, tier);

      const result = await runJobMatch({
        userId,
        resumeId,
        jobDescription,
        operationType,
        personalDetails,
        tier,
      });

      // ── Non-blocking usage log ─────────────────────────────────────────
      const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
      aiUsageService.logAiCall({
        userId,
        feature:   operationType,
        model,
        success:   true,
        errorCode: null,
      }).catch(() => {});

      return res.status(200).json({
        success: true,
        data: {
          jobMatch:         result,
          engine:           result.engine,
          creditsRemaining: result.creditsRemaining ?? null,
        },
      });

    } catch (err) {
      return next(err);
    }
  }
);

module.exports = router;