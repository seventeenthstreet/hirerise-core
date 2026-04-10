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

const {
  isAsyncOperation,
  enqueueAiJob,
} = require('../../core/aiJobQueue');

const logger = require('../../utils/logger');

let cachedAnalysisRunner = null;

/**
 * Resolve active Supabase-safe analysis runner once.
 * Wave 3 hardening:
 * - removes repeated dynamic require drift
 * - prevents fallback inconsistency across requests
 * - improves hot-path latency
 */
function resolveAnalysisRunner() {
  if (cachedAnalysisRunner) {
    return cachedAnalysisRunner;
  }

  try {
    const svc = require('./analysis.service');

    if (typeof svc.runAnalysis === 'function') {
      cachedAnalysisRunner = svc.runAnalysis;
      return cachedAnalysisRunner;
    }
  } catch (err) {
    logger.warn('Primary analysis.service load failed', {
      error: err.message,
    });
  }

  try {
    const svc = require('./jobMatch.service');

    if (typeof svc.runAnalysis === 'function') {
      cachedAnalysisRunner = svc.runAnalysis;
      return cachedAnalysisRunner;
    }

    if (typeof svc.runJobMatchAnalysis === 'function') {
      cachedAnalysisRunner = svc.runJobMatchAnalysis;
      return cachedAnalysisRunner;
    }
  } catch (err) {
    logger.error('Supabase fallback runner unavailable', {
      error: err.message,
    });
  }

  throw new Error(
    'Analysis route misconfiguration: no valid Supabase-safe analysis runner found.'
  );
}

const router = express.Router();

// ── Liveness probe ────────────────────────────────────────────────────────────
// GET /api/v1/analytics/health
// Auth-gated (authenticate runs at mount point in server.js).
// Used to verify the analytics module is reachable with a valid token.
router.get('/health', (_req, res) => {
  res.status(200).json({
    success: true,
    status: 'healthy',
    module: 'analytics',
    ts: new Date().toISOString(),
  });
});

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
      const runAnalysis = resolveAnalysisRunner();

      const userId = req.user.id;
      const tier =
        req.user.normalizedTier ?? normalizeTier(req.user.plan);

      const { resumeId, operationType } = req.body;

      /**
       * Stable request signature for idempotent async processing
       * Wave 3.4 preparation:
       * allows queue layer + cache layer to dedupe retries
       */
      const requestSignature = [
        userId,
        resumeId,
        operationType,
        tier,
      ].join(':');

      if (isAsyncOperation(operationType)) {
        const { jobId, pollUrl } = await enqueueAiJob({
          userId,
          operationType,
          dedupeKey: requestSignature,
          payload: {
            resumeId,
            tier,
            requestSignature,
            _creditReservation: req._creditReservation ?? null,
            requestMeta: {
              source: 'analysis.route',
              supabaseFirst: true,
            },
          },
          tier,
        });

        return res.status(202).json({
          success: true,
          async: true,
          data: {
            jobId,
            pollUrl,
            dedupeKey: requestSignature,
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
        useSupabase: true,
        requestSignature,
      });

      const safeResult = result || {};
      const {
        _inputTokens,
        _outputTokens,
        _cached,
        _supabaseTrace,
        ...cleanResult
      } = safeResult;

      return res.status(200).json({
        success: true,
        async: false,
        data: {
          analysis: cleanResult,
          requestSignature,
          creditsRemaining:
            cleanResult.creditsRemaining ?? null,
          engine:
            cleanResult.engine ?? 'supabase-first',
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

router.use('/', require('./jobMatch.route'));

module.exports = router;