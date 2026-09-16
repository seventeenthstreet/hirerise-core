'use strict';

/**
 * src/modules/student-onboarding/controllers/aspiration.controller.js
 *
 * ASPIRATION STEP CONTROLLER — Phase 2
 * ─────────────────────────────────────
 * Thin HTTP adapter. Extracts context from req, delegates to service,
 * returns standardized JSON responses.
 *
 * DOES NOT:
 *   • contain business logic
 *   • access the database directly
 *   • validate payloads (done by validator middleware before reaching here)
 *
 * PHASE 1 LIFECYCLE PASS — session advance now backend-owned:
 *   saveAspiration() now calls recommendation-lifecycle.service.js
 *   immediately after aspiration data is saved, to authoritatively advance
 *   the session past 'aspiration' and atomically kick off Recommendation
 *   generation. This intentionally lives here (the controller) rather than
 *   in aspiration.service.js, which has a regression test asserting it
 *   never imports session.service — see recommendation-lifecycle.service.js
 *   for the full reasoning. The frontend's existing direct-Supabase
 *   session-advance call is left in place (out of scope for this pass) and
 *   is now a redundant, idempotent no-op.
 *
 * IDENTITY:
 *   Student identity is always req.user.id, taken from the verified JWT via
 *   the `authenticate` middleware applied at the server.js mount point.
 *   The request body is never trusted for identity — there is no `user_id`
 *   field accepted from the client anywhere in this file.
 *
 * RESPONSE CONTRACTS:
 *
 *   GET /step/aspiration
 *   {
 *     ok: true,
 *     aspiration: { careerInterests, motivationDriver, timeHorizon } | null
 *   }
 *
 *   POST /step/aspiration
 *   {
 *     ok: true,
 *     aspiration: { careerInterests, motivationDriver, timeHorizon }
 *   }
 */

const { getAspirationStep, saveAspirationStep } = require('../services/aspiration.service');
const { initiateProcessingTransition } = require('../services/recommendation-lifecycle.service');

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/student-onboarding/v2/step/aspiration
// ─────────────────────────────────────────────────────────────────────────────

async function getAspiration(req, res, next) {
  try {
    const result = await getAspirationStep(
      { supabase: req.supabase },
      req.user.id,
    );
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/student-onboarding/v2/step/aspiration
// req.validatedAspiration is set by validateSaveAspirationMiddleware.
// ─────────────────────────────────────────────────────────────────────────────

async function saveAspiration(req, res, next) {
  try {
    const result = await saveAspirationStep(
      { supabase: req.supabase },
      req.user.id,
      req.validatedAspiration,
    );

    // Authoritative backend session-advance + guarded generation kickoff.
    // Response shape is intentionally unchanged (session-advance failures
    // here still fail the request, matching every other step's
    // convention) — the generation kickoff itself never throws (isolated
    // internally; see recommendation-lifecycle.service.js).
    await initiateProcessingTransition(req.user.id);

    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
}

module.exports = { getAspiration, saveAspiration };
