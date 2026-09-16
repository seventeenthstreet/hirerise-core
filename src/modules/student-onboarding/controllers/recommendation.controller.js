'use strict';

/**
 * src/modules/student-onboarding/controllers/recommendation.controller.js
 *
 * RECOMMENDATION RETRY / REGENERATION CONTROLLER — Phase 1 Pass 3
 * ─────────────────────────────────────────────────────────────────
 * Thin HTTP adapter for the explicit, authenticated Recommendation
 * retry/regeneration operation. Delegates the entire lifecycle transition
 * and concurrency guard to recommendation-engine.js#initiateRetry — this
 * file contains no business logic of its own.
 *
 * IDENTITY / OWNERSHIP:
 *   Student identity is always req.user.id, taken from the verified JWT via
 *   the `authenticate` middleware applied at the server.js mount point.
 *   Nothing is ever read from req.body — there is no `userId`, `status`,
 *   `creditCost`, `result`, or any other client-supplied field accepted
 *   anywhere in this file. A client cannot retry, inspect, or influence
 *   another Student's Recommendation: initiateRetry() is always scoped to
 *   the authenticated user's own row via `user_id = req.user.id`.
 *
 * RESPONSE CONTRACT:
 *
 *   POST /v2/recommendation/retry
 *
 *   202 { ok: true,  status: 'pending' }   — retry/regeneration started
 *   200 { ok: true,  status: 'pending' }   — already in progress (idempotent ack)
 *   409 { ok: false, error: '...' }        — nothing eligible to retry
 *                                             (no result yet, or still
 *                                             'not_started' — initial
 *                                             generation has not run)
 *
 * Never returns provider output, prompts, stack traces, or any other
 * generation internals — initiateRetry() itself never surfaces them, and
 * this controller passes through only the safe `{ started, status }` shape
 * it returns.
 */

const recommendationEngine = require('../services/recommendation-engine');

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/student-onboarding/v2/recommendation/retry
// ─────────────────────────────────────────────────────────────────────────────

async function retryRecommendation(req, res, next) {
  try {
    const result = await recommendationEngine.initiateRetry(req.user.id);

    if (result.started) {
      return res.status(202).json({ ok: true, status: 'pending' });
    }

    if (result.status === 'pending') {
      // Another retry/generation is already in flight for this Student —
      // idempotent acknowledgement, not an error.
      return res.status(200).json({ ok: true, status: 'pending' });
    }

    return res.status(409).json({
      ok: false,
      error: 'No recommendation is available to retry yet. Complete onboarding to generate one first.',
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { retryRecommendation };
