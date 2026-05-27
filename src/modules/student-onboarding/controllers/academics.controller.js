'use strict';

/**
 * core/src/modules/student-onboarding/controllers/academics.controller.js
 *
 * ACADEMIC STEP CONTROLLER — Phase 3A
 * ─────────────────────────────────────
 * Thin HTTP adapter. Extracts context from req, delegates to service,
 * returns standardized JSON responses.
 *
 * DOES NOT:
 *   • contain business logic
 *   • access the database directly
 *   • calculate signal quality
 *   • manage sessions
 *   • inject sessionService via req (imported directly by the service)
 *
 * RESPONSE CONTRACTS:
 *
 *   GET /step/academics
 *   {
 *     ok: true,
 *     academics: { years: { ... } },
 *     signal_quality: { is_sufficient, committed_year_count, total_subject_count }
 *   }
 *
 *   POST /step/academics
 *   {
 *     ok: true,
 *     academics: { years: { ... } },
 *     session: { id, current_step },
 *     next_step: 'activities' | 'academics',
 *     signal_quality: { is_sufficient, committed_year_count, total_subject_count }
 *   }
 */

const { getAcademicsStep, saveAcademicsStep } = require('../services/academic.service');

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/student-onboarding/v2/step/academics
// ─────────────────────────────────────────────────────────────────────────────

async function getAcademics(req, res, next) {
  try {
    const result = await getAcademicsStep(
      {
        supabase:    req.supabase,
        diagnostics: req.diagnostics,
      },
      req.user.id,
      req.onboardingSession.id,
    );
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/student-onboarding/v2/step/academics
// ─────────────────────────────────────────────────────────────────────────────

async function saveAcademics(req, res, next) {
  try {
    const result = await saveAcademicsStep(
      {
        supabase:    req.supabase,
        diagnostics: req.diagnostics,
      },
      req.user.id,
      req.onboardingSession.id,
      req.body,
    );
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
}

module.exports = { getAcademics, saveAcademics };
