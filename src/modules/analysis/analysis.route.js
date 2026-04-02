'use strict';

const express = require('express');

const { authenticate } = require('../../middleware/auth.middleware');
const { creditGuard } = require('../../middleware/creditGuard.middleware');
const { tierQuota } = require('../../middleware/tierquota.middleware');
const { sanitizeAiInputs } = require('../../middleware/aiSanitizer.middleware');
const { aiCostGuard } = require('../../middleware/aiCostGuard.middleware');
const {
  validateBody,
  AnalysisBodySchema,
} = require('../../middleware/validation.schemas');
const { normalizeTier } = require('../../middleware/requireTier.middleware');

const { runAnalysis } = require('./analysis.service');
const {
  isAsyncOperation,
  enqueueAiJob,
} = require('../../core/aiJobQueue');

const router = express.Router();

router.post(
  '/',
  authenticate,
  validateBody(AnalysisBodySchema),
  tierQuota('fullAnalysis'),
  sanitizeAiInputs(['resumeText']),
  aiCostGuard,
  creditGuard('fullAnalysis'),
  async (req, res, next) => {
    try {
      const userId = req.user.uid;
      const tier = req.user.normalizedTier ?? normalizeTier(req.user.plan);
      const { resumeId, operationType } = req.body;

      if (isAsyncOperation(operationType)) {
        const { jobId, pollUrl } = await enqueueAiJob({
          userId,
          operationType,
          payload: {
            resumeId,
            tier,
            _creditReservation: req._creditReservation ?? null,
          },
          tier,
        });

        return res.status(202).json({
          success: true,
          async: true,
          data: {
            jobId,
            pollUrl,
            message: 'Analysis queued. Poll the pollUrl for results.',
            estimatedWaitSeconds: 15,
          },
        });
      }

      const result = await runAnalysis({
        userId,
        resumeId,
        operationType,
        tier,
        req,
      });

      const safeResult = result || {};
      const {
        _inputTokens,
        _outputTokens,
        _cached,
        ...cleanResult
      } = safeResult;

      return res.status(200).json({
        success: true,
        async: false,
        data: {
          analysis: cleanResult,
          creditsRemaining: cleanResult.creditsRemaining ?? null,
          engine: cleanResult.engine ?? null,
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

router.use('/', require('./jobMatch.route'));

module.exports = router;