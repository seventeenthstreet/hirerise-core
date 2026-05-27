'use strict';

/**
 * src/modules/student-onboarding/controllers/cognitive.controller.js
 *
 * COGNITIVE STEP CONTROLLER — Phase 3C
 * ─────────────────────────────────────
 * Thin HTTP adapter. Extracts context from req, delegates to service,
 * returns standardized JSON responses.
 *
 * DOES NOT:
 *   • contain business logic
 *   • access the database directly
 *   • validate payloads (done by validator middleware before reaching here)
 *   • advance the onboarding session (page.tsx useUpdateOnboardingStep handles that)
 *
 * RESPONSE CONTRACT:
 *   All responses: { ok: true, ...payload } on success
 *   All errors:    passed to next(err) for the global error handler
 *
 * ROUTE MAP (registered in cognitive.routes.js):
 *   GET  /step/cognitive                  → getCognitiveStep
 *   POST /step/cognitive/response         → saveResponse
 *   POST /step/cognitive/responses/batch  → batchSaveResponses
 *   POST /step/cognitive/commit           → commitStep
 */

const svc = require('../services/cognitive.service');

// ─────────────────────────────────────────────────────────────────────────────
// GET — full step data (taxonomy + responses + signal quality)
// ─────────────────────────────────────────────────────────────────────────────

async function getCognitiveStep(req, res, next) {
  try {
    const result = await svc.getCognitiveStep(
      { supabase: req.supabase },
      req.user.id,
    );
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST — save a single question response (progressive persistence)
// Payload pre-validated by validateSaveResponseMiddleware → req.validatedCognitiveResponse
// ─────────────────────────────────────────────────────────────────────────────

async function saveResponse(req, res, next) {
  try {
    const result = await svc.saveResponse(
      { supabase: req.supabase },
      req.user.id,
      req.validatedCognitiveResponse,
    );
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST — batch save multiple responses at once
// Payload pre-validated by validateBatchResponsesMiddleware → req.validatedBatchResponses
// ─────────────────────────────────────────────────────────────────────────────

async function batchSaveResponses(req, res, next) {
  try {
    const result = await svc.batchSaveResponses(
      { supabase: req.supabase },
      req.user.id,
      req.validatedBatchResponses.responses,
    );
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST — commit the cognitive step
// Validates signal sufficiency, extracts signals into student_cognitive_signals.
// Does NOT advance the session — useUpdateOnboardingStep handles that client-side.
// ─────────────────────────────────────────────────────────────────────────────

async function commitStep(req, res, next) {
  try {
    const result = await svc.commitCognitiveStep(
      { supabase: req.supabase },
      req.user.id,
    );
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  getCognitiveStep,
  saveResponse,
  batchSaveResponses,
  commitStep,
};
