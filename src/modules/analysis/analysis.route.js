'use strict';

/**
 * src/modules/analysis/analysis.route.js
 *
 * FIX: cleanResult.engine ?? 'supabase-first' violated the DB CHECK constraint
 *      on resume_analyses.engine which only allows 'free' | 'premium'.
 *      Fixed to normalise to 'premium' when engine is not 'free'.
 *
 * FIX: isAsyncOperation was imported but not exported from aiJobQueue.js.
 *      That module is now fixed; this file's import is correct as-is.
 */

const express = require('express');

const { authenticate }            = require('../../middleware/auth.middleware');
const { creditGuard }             = require('../../middleware/creditGuard.middleware');
const { tierQuota }               = require('../../middleware/tierquota.middleware');
const { sanitizeAiInputs }        = require('../../middleware/aiSanitizer.middleware');
const { aiCostGuard }             = require('../../middleware/aiCostGuard.middleware');
const { validateBody, AnalysisBodySchema } = require('../../middleware/validation.schemas');
const { normalizeTier }           = require('../../middleware/requireTier.middleware');

const { isAsyncOperation, enqueueAiJob } = require('../../core/aiJobQueue');

const logger = require('../../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// Analysis runner cache
// Resolves once at runtime; avoids repeated dynamic-require drift.
// ─────────────────────────────────────────────────────────────────────────────

let cachedAnalysisRunner = null;

function resolveAnalysisRunner() {
  if (cachedAnalysisRunner) return cachedAnalysisRunner;

  try {
    const svc = require('./analysis.service');
    if (typeof svc.runAnalysis === 'function') {
      cachedAnalysisRunner = svc.runAnalysis;
      return cachedAnalysisRunner;
    }
  } catch (err) {
    logger.warn('Primary analysis.service load failed', { error: err.message });
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
    logger.error('Supabase fallback runner unavailable', { error: err.message });
  }

  throw new Error(
    'Analysis route misconfiguration: no valid analysis runner found.'
  );
}

/**
 * Normalise engine field to the two values permitted by the DB CHECK constraint:
 *   resume_analyses.engine CHECK (engine IN ('free', 'premium'))
 *
 * FIX: the previous fallback 'supabase-first' is not a valid engine value and
 * would cause every upsert to throw a Postgres CHECK constraint violation.
 *
 * @param {string|undefined} engine
 * @returns {'free'|'premium'}
 */
function normalizeEngine(engine) {
  return engine === 'free' ? 'free' : 'premium';
}

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
      const runAnalysis = resolveAnalysisRunner();

      const userId = req.user.id;
      const tier   = req.user.normalizedTier ?? normalizeTier(req.user.plan);

      const { resumeId, operationType } = req.body;

      const requestSignature = [userId, resumeId, operationType, tier].join(':');

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
            requestMeta: { source: 'analysis.route', supabaseFirst: true },
          },
          tier,
        });

        return res.status(202).json({
          success: true,
          async:   true,
          data: {
            jobId,
            // NOTE: This pollUrl points at GET /api/v1/ai-jobs/:jobId.
            // It is INTERNAL — used here because this is an AI analysis job,
            // not a resume upload. Frontend polling for RESUME processing
            // must use GET /api/v1/resumes/:resumeId/status instead.
            // See docs/frontend-contract.md.
            pollUrl,
            dedupeKey:            requestSignature,
            message:              'Analysis queued. Poll the pollUrl for results.',
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
        useSupabase:      true,
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
        async:   false,
        data: {
          analysis: cleanResult,
          requestSignature,
          creditsRemaining: cleanResult.creditsRemaining ?? null,
          // FIX: was `cleanResult.engine ?? 'supabase-first'`
          // 'supabase-first' is not a valid DB value → CHECK constraint violation
          engine: normalizeEngine(cleanResult.engine),
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

router.use('/', require('./jobMatch.route'));

module.exports = router;