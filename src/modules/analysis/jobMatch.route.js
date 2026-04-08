'use strict';

const express = require('express');
const { authenticate } = require('../../middleware/auth.middleware');
const { creditGuard } = require('../../middleware/creditGuard.middleware');
const { sanitizeAiInputs } = require('../../middleware/aiSanitizer.middleware');
const { aiCostGuard } = require('../../middleware/aiCostGuard.middleware');
const { runJobMatch } = require('./jobMatch.service');
const { normalizeTier } = require('../../middleware/requireTier.middleware');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const {
  isAsyncOperation,
  enqueueAiJob,
} = require('../../core/aiJobQueue');

const router = express.Router();

const VALID_OPERATIONS = ['jobMatchAnalysis', 'jobSpecificCV'];

router.post(
  '/job',
  authenticate,
  sanitizeAiInputs(['jobDescription']),
  aiCostGuard,
  creditGuard('jobMatchAnalysis'),
  async (req, res, next) => {
    try {
      const userId = req.user.id;
      const tier = req.user.normalizedTier ?? normalizeTier(req.user.plan);

      const {
        resumeId,
        jobDescription,
        operationType = 'jobMatchAnalysis',
        personalDetails,
      } = req.body;

      if (!resumeId) {
        return next(
          new AppError(
            'resumeId is required.',
            400,
            {},
            ErrorCodes.VALIDATION_ERROR
          )
        );
      }

      if (!jobDescription) {
        return next(
          new AppError(
            'jobDescription is required.',
            400,
            {},
            ErrorCodes.VALIDATION_ERROR
          )
        );
      }

      if (!VALID_OPERATIONS.includes(operationType)) {
        return next(
          new AppError(
            `Invalid operationType. Must be one of: ${VALID_OPERATIONS.join(', ')}`,
            400,
            {},
            ErrorCodes.VALIDATION_ERROR
          )
        );
      }

      if (isAsyncOperation(operationType)) {
        const { jobId, pollUrl } = await enqueueAiJob({
          userId,
          operationType,
          payload: {
            resumeId,
            jobDescription,
            personalDetails: personalDetails ?? {},
            tier,
          },
          tier,
        });

        return res.status(202).json({
          success: true,
          async: true,
          data: {
            jobId,
            pollUrl,
            message:
              'Job-specific CV generation queued. Poll the pollUrl for results.',
            estimatedWaitSeconds: 20,
          },
        });
      }

      const result = await runJobMatch({
        userId,
        resumeId,
        jobDescription,
        operationType,
        personalDetails,
        tier,
      });

      return res.status(200).json({
        success: true,
        async: false,
        data: {
          jobMatch: result,
          engine: result?.engine ?? null,
          creditsRemaining: result?.creditsRemaining ?? null,
        },
      });
    } catch (error) {
      return next(error);
    }
  }
);

module.exports = router;