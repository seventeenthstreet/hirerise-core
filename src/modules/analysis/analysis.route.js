'use strict';

/**
 * analysis.route.js — PHASE 3 UPDATE
 *
 * CHANGES FROM PHASE 2:
 *
 *   1. aiCostGuard added to middleware stack (after authenticate, before creditGuard).
 *      Blocks requests when a user has exceeded their daily AI cost limit.
 *      Free: $0.10/day, Pro: $2.00/day, Elite: $10.00/day.
 *
 *   2. tier forwarded into runAnalysis() call so engines can pass it down
 *      to resolveModelForTier() for cost-aware model selection.
 *
 *   3. recordAiCost() called after successful synchronous analysis calls
 *      (async dispatch path handled by aiJobQueue processor which calls engine directly).
 *
 * PHASE 2 CHANGES RETAINED:
 *   - sanitizeAiInputs
 *   - 202 async dispatch for fullAnalysis
 *   - creditGuard, tierQuota, aiUsageService
 */

const express = require('express');
const { authenticate }     = require('../../middleware/auth.middleware');
const { creditGuard }      = require('../../middleware/creditGuard.middleware');
const { tierQuota }        = require('../../middleware/tierquota.middleware');
const { validateBody, AnalysisBodySchema } = require('../../middleware/validation.schemas');
const { sanitizeAiInputs } = require('../../middleware/aiSanitizer.middleware');
const { aiCostGuard, recordAiCost } = require('../../middleware/aiCostGuard.middleware');  // Phase 3
const { runAnalysis }      = require('./analysis.service');
const { normalizeTier }    = require('../../middleware/requireTier.middleware');
const aiUsageService       = require('../../services/aiUsage.service');
const modelRegistry        = require('../../ai/circuit-breaker/model-registry');  // Phase 3

const { isAsyncOperation, enqueueAiJob } = require('../../core/aiJobQueue');

let logUsageToFirestore;
try {
  logUsageToFirestore = require('../../services/admin/logUsageToFirestore').logUsageToFirestore;
} catch (_) {
  logUsageToFirestore = async () => {};
}

const router = express.Router();

// ── POST /api/v1/analyze ──────────────────────────────────────────────────────
router.post(
  '/',
  validateBody(AnalysisBodySchema),
  tierQuota('fullAnalysis'),
  sanitizeAiInputs(['resumeText']),
  aiCostGuard,                               // Phase 3: daily cost cap check
  creditGuard('fullAnalysis'),
  async (req, res, next) => {
    try {
      const userId         = req.user.uid;
      const tier           = req.user.normalizedTier ?? normalizeTier(req.user.plan);
      const { resumeId, operationType } = req.body;

      await aiUsageService.checkAndIncrement(userId, tier);

      // ── Async dispatch (fullAnalysis) ─────────────────────────────────────
      if (operationType === 'fullAnalysis' && isAsyncOperation('fullAnalysis')) {
        const { jobId, pollUrl } = await enqueueAiJob({
          userId,
          operationType: 'fullAnalysis',
          payload: {
            resumeId,
            tier,                            // Phase 3: forward tier for engine model selection
            _creditReservation: req._creditReservation ?? null,
          },
          tier,
        });

        aiUsageService.logAiCall({
          userId, feature: operationType,
          model:     modelRegistry.resolveModelForTier(operationType, tier),  // Phase 3
          success:   true, errorCode: null,
        }).catch(() => {});

        return res.status(202).json({
          success: true, async: true,
          data: {
            jobId, pollUrl,
            message: 'Analysis queued. Poll the pollUrl for results.',
            estimatedWaitSeconds: 15,
          },
        });
      }

      // ── Synchronous path (generateCV) ─────────────────────────────────────
      const result = await runAnalysis({
        userId, resumeId, operationType, tier,
        req,
        userTier: tier,   // Phase 3: explicit tier forwarding
      });

      const model = modelRegistry.resolveModelForTier(operationType, tier);  // Phase 3

      // Phase 3: record actual cost for per-user budget enforcement
      if (result && !result._cached) {
        const costUSD = modelRegistry.estimateCost(
          model,
          result._inputTokens  ?? 0,
          result._outputTokens ?? 0
        );
        recordAiCost(userId, tier, costUSD).catch(() => {});
      }

      aiUsageService.logAiCall({
        userId, feature: operationType, model, success: true, errorCode: null,
      }).catch(() => {});

      logUsageToFirestore({
        userId, feature: operationType, tier, model,
        inputTokens:  result._inputTokens  ?? 0,
        outputTokens: result._outputTokens ?? 0,
        planAmount:   req.user.planAmount   ?? null,
      }).catch(() => {});

      const { _inputTokens, _outputTokens, ...cleanResult } = result;

      return res.status(200).json({
        success: true, async: false,
        data: {
          analysis:         cleanResult,
          creditsRemaining: cleanResult.creditsRemaining ?? null,
          engine:           cleanResult.engine,
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

router.use('/', require('./jobMatch.route'));

module.exports = router;








