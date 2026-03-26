'use strict';

/**
 * jobMatch.route.js — PHASE 3 UPDATE
 *
 * CHANGES FROM PHASE 2:
 *   1. aiCostGuard added to middleware stack.
 *   2. tier forwarded into runJobMatch() so engines use resolveModelForTier().
 *   3. recordAiCost() called after synchronous job match completions.
 */

const express  = require('express');
const { authenticate }     = require('../../middleware/auth.middleware');
const { creditGuard }      = require('../../middleware/creditGuard.middleware');
const { sanitizeAiInputs } = require('../../middleware/aiSanitizer.middleware');
const { aiCostGuard, recordAiCost } = require('../../middleware/aiCostGuard.middleware');  // Phase 3
const { runJobMatch }      = require('./jobMatch.service');
const { normalizeTier }    = require('../../middleware/requireTier.middleware');
const aiUsageService       = require('../../services/aiUsage.service');
const modelRegistry        = require('../../ai/circuit-breaker/model-registry');  // Phase 3
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const { isAsyncOperation, enqueueAiJob } = require('../../core/aiJobQueue');

const router = express.Router();

const VALID_OPERATIONS = ['jobMatchAnalysis', 'jobSpecificCV'];

router.post(
  '/job',
  sanitizeAiInputs(['jobDescription']),
  aiCostGuard,                               // Phase 3: daily cost cap check
  creditGuard('jobMatchAnalysis'),
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

      await aiUsageService.checkAndIncrement(userId, tier);

      // ── Async dispatch (jobSpecificCV) ────────────────────────────────────
      if (operationType === 'jobSpecificCV' && isAsyncOperation('jobSpecificCV')) {
        const { jobId, pollUrl } = await enqueueAiJob({
          userId,
          operationType: 'jobSpecificCV',
          payload: {
            resumeId,
            jobDescription: req.body.jobDescription,
            personalDetails: personalDetails ?? {},
            tier,           // Phase 3: forward tier
          },
          tier,
        });

        aiUsageService.logAiCall({
          userId, feature: operationType,
          model:   modelRegistry.resolveModelForTier(operationType, tier),  // Phase 3
          success: true, errorCode: null,
        }).catch(() => {});

        return res.status(202).json({
          success: true, async: true,
          data: {
            jobId, pollUrl,
            message: 'Job-specific CV generation queued. Poll the pollUrl for results.',
            estimatedWaitSeconds: 20,
          },
        });
      }

      // ── Synchronous path (jobMatchAnalysis) ───────────────────────────────
      const result = await runJobMatch({
        userId, resumeId, jobDescription, operationType, personalDetails, tier,
        userTier: tier,   // Phase 3: explicit tier forwarding
      });

      const model = modelRegistry.resolveModelForTier(operationType, tier);  // Phase 3

      // Phase 3: record cost for per-user budget enforcement
      if (result && !result._cached) {
        const costUSD = modelRegistry.estimateCost(model, 0, 0); // tokens not available from sync path
        // Approximate: jobMatchAnalysis ~1200 out tokens at Sonnet = ~$0.018
        // Overriding with token-based estimate if available in result
        if (result._inputTokens || result._outputTokens) {
          const exactCost = modelRegistry.estimateCost(
            model, result._inputTokens ?? 0, result._outputTokens ?? 0
          );
          recordAiCost(userId, tier, exactCost).catch(() => {});
        } else {
          // Approximate estimate to still enforce daily limits
          const approxCost = modelRegistry.estimateCost(model, 400, 1200);
          recordAiCost(userId, tier, approxCost).catch(() => {});
        }
      }

      aiUsageService.logAiCall({
        userId, feature: operationType, model, success: true, errorCode: null,
      }).catch(() => {});

      return res.status(200).json({
        success: true, async: false,
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








