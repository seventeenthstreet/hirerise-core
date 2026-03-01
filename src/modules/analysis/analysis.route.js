'use strict';

/**
 * analysis.route.js — HARDENED VERSION
 * =====================================
 * CHANGES FROM ORIGINAL:
 *
 *   1. Added Zod validation middleware (validateBody)
 *      replaces the manual if(!resumeId) / if(!operationType) checks
 *      that were inline in the route handler.
 *
 *   2. Added tierQuota middleware BEFORE creditGuard.
 *      tierQuota blocks free users who've hit monthly cap.
 *      creditGuard blocks pro users with no credits.
 *      Together they form a complete 3-layer protection system.
 *
 *   3. Moved remaining inline validation out of the handler —
 *      handler now contains ONLY the service call and response formatting.
 *      No business logic, no validation logic.
 *
 *   4. Added logUsageToFirestore hook (non-blocking) after successful analysis.
 *      This populates the usageLogs collection for admin metrics.
 *
 * MIGRATION NOTE:
 *   Replace src/modules/analysis/analysis.route.js with this file.
 *   Requires: zod package (`npm install zod`)
 */

const express = require('express');
const { authenticate }   = require('../../middleware/auth.middleware');
const { creditGuard }    = require('../../middleware/creditGuard.middleware');
const { tierQuota }      = require('../../middleware/tierquota.middleware');
const { validateBody, AnalysisBodySchema } = require('../../middleware/validation.schemas');
const { runAnalysis }    = require('./analysis.service');
const { normalizeTier }  = require('../../middleware/requireTier.middleware');
const aiUsageService     = require('../../services/aiUsage.service');

// Import from previous session's delivered files
// (adjust path based on where you put them)
let logUsageToFirestore;
try {
  logUsageToFirestore = require('../../services/admin/logUsageToFirestore').logUsageToFirestore;
} catch (_) {
  // Graceful fallback if admin services aren't yet wired
  logUsageToFirestore = async () => {};
}

const router = express.Router();

// ── POST /api/v1/analyze ──────────────────────────────────────────────────────
// Resume analysis: fullAnalysis | generateCV
router.post(
  '/',
  authenticate,
  validateBody(AnalysisBodySchema),          // ← Phase 1: Zod validation
  tierQuota('fullAnalysis'),                 // ← Phase 3: monthly cap check
  creditGuard('fullAnalysis'),               // ← existing credit check
  async (req, res, next) => {
    try {
      const userId    = req.user.uid;
      const tier      = req.user.normalizedTier ?? normalizeTier(req.user.plan);
      const { resumeId, operationType } = req.body; // already validated + typed by Zod

      // ── AI monthly hard-cap check ────────────────────────────────────────
      // checkAndIncrement throws 429 AppError if cap reached.
      // It also atomically increments the counter on success.
      await aiUsageService.checkAndIncrement(userId, tier);

      const result = await runAnalysis({ userId, resumeId, operationType, tier });

      // ── Non-blocking usage logging ───────────────────────────────────────
      const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';

      aiUsageService.logAiCall({
        userId,
        feature:   operationType,
        model,
        success:   true,
        errorCode: null,
      }).catch(() => {});

      logUsageToFirestore({
        userId,
        feature:     operationType,
        tier,
        model,
        inputTokens:  result._inputTokens  ?? 0,
        outputTokens: result._outputTokens ?? 0,
        planAmount:   req.user.planAmount   ?? null,
      }).catch(() => {});

      // Strip internal fields from response
      const { _inputTokens, _outputTokens, ...cleanResult } = result;

      return res.status(200).json({
        success: true,
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

// ── Sub-routes for job matching ────────────────────────────────────────────────
router.use('/', require('./jobMatch.route'));

module.exports = router;