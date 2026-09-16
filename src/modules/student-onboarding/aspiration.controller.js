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
 *   • advance the onboarding session (owned entirely by the frontend's
 *     existing useUpdateOnboardingStep call — see services/aspiration.service.js
 *     for the full reasoning)
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
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
}

module.exports = { getAspiration, saveAspiration };
