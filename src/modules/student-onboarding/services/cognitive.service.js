'use strict';

/**
 * src/modules/student-onboarding/services/cognitive.service.js
 *
 * BUSINESS LOGIC — Cognitive & Processing Intelligence (Phase 3C)
 *
 * ── SESSION ADVANCEMENT CONTRACT ──────────────────────────────────────────
 * Phase 3C cognitive step DOES NOT advance the session server-side.
 * This mirrors the 'academics' step pattern in page.tsx:
 *
 *   case 'cognitive': {
 *     await advanceStep({ completedStep: 'cognitive', nextStep: 'aspiration' });
 *   }
 *
 * The frontend calls useUpdateOnboardingStep after cognitive-step.tsx calls
 * onComplete(). This service handles ONLY:
 *   1. Fetching step data (taxonomy + responses + signal quality)
 *   2. Progressive response persistence
 *   3. Signal extraction at commit time (writes student_cognitive_signals)
 *
 * The session row is touched by useUpdateOnboardingStep — not this service.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * DOES NOT:
 *   • advance the onboarding session (page.tsx handles this)
 *   • access the database directly (delegates to cognitive.repository.js)
 *   • handle HTTP (belongs in controller)
 *   • run recommendation engines or AI inference
 */

const repo = require('../repositories/cognitive.repository');
const {
  buildCognitiveSignalBundle,
} = require('../signals/cognitive.signals');
const {
  validateOptionOwnership,
  validateMultiSelectAllowed,
} = require('../validators/cognitive.validator');

// ─────────────────────────────────────────────────────────────────────────────
// GET COGNITIVE STEP
// Returns taxonomy + existing responses + signal quality.
// Safe to call at any time — drives refresh recovery and partial-save restoration.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{ supabase: object }} ctx
 * @param {string} userId
 * @returns {Promise<{
 *   taxonomy:       object[],
 *   responses:      object[],
 *   signals:        object|null,
 *   signal_quality: object
 * }>}
 */
async function getCognitiveStep(ctx, userId) {
  const { supabase } = ctx;

  const [taxonomyRows, cognitiveData, signalQuality] = await Promise.all([
    repo.fetchCognitiveTaxonomy(supabase),
    repo.fetchStudentCognitiveData(supabase, userId),
    repo.fetchCognitiveSignalQuality(supabase, userId),
  ]);

  return {
    taxonomy:       taxonomyRows,
    responses:      cognitiveData.responses,
    signals:        cognitiveData.signals,
    signal_quality: signalQuality,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SAVE RESPONSE (Progressive persistence — one question at a time)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{ supabase: object }} ctx
 * @param {string} userId
 * @param {{ question_id: string, selected_option_keys: string[], is_partial: boolean }} validated
 * @returns {Promise<{ response: object, signal_quality: object }>}
 */
async function saveResponse(ctx, userId, validated) {
  const { supabase } = ctx;
  const { question_id, selected_option_keys, is_partial } = validated;

  const question = await repo.fetchQuestionWithOptions(supabase, question_id);
  if (!question) {
    const err = new Error(`Cognitive question "${question_id}" not found or is inactive.`);
    err.status = 404;
    throw err;
  }

  const validOptionKeys = (question.cognitive_options ?? []).map((o) => o.option_key);
  validateOptionOwnership(selected_option_keys, validOptionKeys, question.question_key);
  validateMultiSelectAllowed(question.allows_multi, selected_option_keys, question.question_key);

  const response = await repo.upsertCognitiveResponse(supabase, {
    user_id: userId,
    question_id,
    selected_option_keys,
    is_partial,
  });

  const signalQuality = await repo.fetchCognitiveSignalQuality(supabase, userId);

  return { response, signal_quality: signalQuality };
}

// ─────────────────────────────────────────────────────────────────────────────
// BATCH SAVE RESPONSES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{ supabase: object }} ctx
 * @param {string} userId
 * @param {{ question_id: string, selected_option_keys: string[] }[]} validatedResponses
 * @returns {Promise<{ responses: object[], signal_quality: object }>}
 */
async function batchSaveResponses(ctx, userId, validatedResponses) {
  const { supabase } = ctx;

  // Validate ownership for ALL before persisting ANY
  await Promise.all(
    validatedResponses.map(async (item) => {
      const question = await repo.fetchQuestionWithOptions(supabase, item.question_id);
      if (!question) {
        const err = new Error(`Cognitive question "${item.question_id}" not found or is inactive.`);
        err.status = 404;
        throw err;
      }
      const validKeys = (question.cognitive_options ?? []).map((o) => o.option_key);
      validateOptionOwnership(item.selected_option_keys, validKeys, question.question_key);
      validateMultiSelectAllowed(question.allows_multi, item.selected_option_keys, question.question_key);
    }),
  );

  const rows = validatedResponses.map((r) => ({
    question_id:          r.question_id,
    selected_option_keys: r.selected_option_keys,
    is_partial:           true,
  }));

  const responses     = await repo.batchUpsertCognitiveResponses(supabase, userId, rows);
  const signalQuality = await repo.fetchCognitiveSignalQuality(supabase, userId);

  return { responses, signal_quality: signalQuality };
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMIT COGNITIVE STEP
// Validates signal sufficiency, extracts signals, marks responses committed.
// Does NOT advance the session — that is handled by useUpdateOnboardingStep
// in the frontend (page.tsx, case 'cognitive').
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{ supabase: object }} ctx
 * @param {string} userId
 * @returns {Promise<{ signals: object, signal_quality: object }>}
 */
async function commitCognitiveStep(ctx, userId) {
  const { supabase } = ctx;

  // 1. Gate on signal sufficiency
  const signalQuality = await repo.fetchCognitiveSignalQuality(supabase, userId);

  if (!signalQuality.is_sufficient) {
    const err = new Error(
      `Cognitive step requires all ${signalQuality.required_total} required questions to be answered. ` +
      `Currently answered: ${signalQuality.required_answered}.`,
    );
    err.status  = 422;
    err.code    = 'COGNITIVE_SIGNAL_INSUFFICIENT';
    err.details = signalQuality;
    throw err;
  }

  // 2. Fetch all responses + taxonomy for signal extraction
  const [responses, taxonomyRows] = await Promise.all([
    repo.fetchStudentCognitiveResponses(supabase, userId),
    repo.fetchCognitiveTaxonomy(supabase),
  ]);

  // 3. Build signal bundle (placeholder infrastructure — no scoring yet)
  const bundle = buildCognitiveSignalBundle(responses, taxonomyRows);

  // 4. Persist derived signals
  const signals = await repo.upsertCognitiveSignals(supabase, {
    user_id:        userId,
    signal_tags:    bundle.signal_tags,
    signal_weights: bundle.signal_weights,
    domain_vectors: bundle.domain_vectors,
    response_count: bundle.response_count,
    is_partial:     false,
    extracted_at:   new Date().toISOString(),
    metadata:       { extraction_version: '3c.1.0' },
  });

  // 5. Mark all responses as committed
  await repo.batchUpsertCognitiveResponses(
    supabase,
    userId,
    responses.map((r) => ({
      question_id:          r.question_id,
      selected_option_keys: r.selected_option_keys,
      is_partial:           false,
    })),
  );

  return {
    signals,
    signal_quality: { ...signalQuality, is_sufficient: true },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  getCognitiveStep,
  saveResponse,
  batchSaveResponses,
  commitCognitiveStep,
};
