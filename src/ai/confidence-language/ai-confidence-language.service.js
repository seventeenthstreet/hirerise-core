'use strict';

/**
 * @file src/ai/confidence-language/ai-confidence-language.service.js
 *
 * AI Confidence Language Service — Phase 4B
 *
 * PURPOSE:
 *   Wires the registry, validator, and telemetry into a single callable
 *   service for the AI augmentation pipeline. This is the integration point
 *   consumed by prompt builders and AI output handlers.
 *
 * GOVERNANCE CONSTRAINTS:
 *   ✅ Does not calculate or modify confidence — reads deterministic tier only
 *   ✅ Deterministic fallback on all failure modes — AI narrative suppressed,
 *      fallback copy returned; calling code never sees a raw failure
 *   ✅ Telemetry injected — never couples to a specific analytics backend
 *   ✅ Pure coordination — no business logic beyond wiring
 *
 * USAGE:
 *   // In an AI output handler:
 *   const service = createConfidenceLanguageService({ adapter });
 *
 *   const result = service.applyToNarrative({
 *     narrative:   aiGeneratedText,
 *     tier:        snapshot.confidence.tier,  // from deterministic engine
 *     capability:  'explanation_enhancement',
 *     promptId:    'explain-recommendations-v1',
 *     promptVersion: '1.0.0',
 *   });
 *
 *   // result.approved === true  → render result.narrative
 *   // result.approved === false → render result.fallback (deterministic copy)
 */

const { validateNarrative, REJECTION_CODES } = require('./ai-confidence-language.validator');
const { VOCABULARY, getPromptGroundingInstructions } = require('./ai-confidence-language.registry');
const {
  emitApplied,
  emitRejected,
  emitFallbackUsed,
  emitViolationDetected,
} = require('./ai-confidence-language.telemetry');

// ─────────────────────────────────────────────────────────────────────────────
// FACTORY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a bound ConfidenceLanguageService instance.
 *
 * @param {Object} deps
 * @param {Object} [deps.adapter] — ObservabilityAdapter instance (optional;
 *                                  telemetry silently disabled if omitted)
 * @returns {ConfidenceLanguageService}
 */
function createConfidenceLanguageService({ adapter } = {}) {
  return Object.freeze({
    applyToNarrative,
    getPromptInstructions,
    getFallbackFor,
  });

  /**
   * Validates an AI-generated narrative against the confidence tier.
   * Always returns an ApplyResult — never throws.
   *
   * @param {Object} params
   * @param {string} params.narrative      — raw AI output
   * @param {string} params.tier           — deterministic confidence tier
   * @param {string} params.capability     — e.g. 'explanation_enhancement'
   * @param {string} params.promptId
   * @param {string} params.promptVersion
   * @returns {ApplyResult}
   *
   * @typedef {Object} ApplyResult
   * @property {boolean} approved   — true if narrative passed; false if suppressed
   * @property {string}  narrative  — the narrative to render (approved text or fallback)
   * @property {boolean} isFallback — true when deterministic fallback was used
   * @property {string}  tier
   * @property {string[] | null} violations
   */
  function applyToNarrative({ narrative, tier, capability, promptId, promptVersion }) {
    // Validate
    const result = validateNarrative(narrative, tier);

    if (result.valid) {
      // ── Approved path ─────────────────────────────────────────────────────
      emitApplied(adapter, { capability, tier, promptId, promptVersion });

      return Object.freeze({
        approved:   true,
        narrative,  // the original AI text — it passed
        isFallback: false,
        tier,
        violations: null,
      });
    }

    // ── Rejection path ────────────────────────────────────────────────────
    emitRejected(adapter, { capability, tier, promptId, violations: result.violations });

    // Emit one violation event per code for granular dashboard metrics
    for (const code of (result.violations ?? [])) {
      emitViolationDetected(adapter, { capability, tier, violationCode: code });
    }

    emitFallbackUsed(adapter, {
      capability,
      tier,
      reason: 'validation_failed',
    });

    return Object.freeze({
      approved:   false,
      narrative:  result.fallback,  // deterministic fallback copy
      isFallback: true,
      tier,
      violations: result.violations,
    });
  }

  /**
   * Returns the prompt grounding instructions for a given tier.
   * Called by prompt builders — injects vocabulary governance into system prompts.
   *
   * @param {string} tier
   * @returns {string}
   */
  function getPromptInstructions(tier) {
    return getPromptGroundingInstructions(tier);
  }

  /**
   * Returns the deterministic fallback copy for a tier.
   * Used when AI call fails entirely (timeout, unavailable) — not just bad output.
   *
   * @param {string} tier
   * @param {string} capability
   * @param {string} [reason='ai_unavailable']
   * @returns {string}
   */
  function getFallbackFor(tier, capability, reason = 'ai_unavailable') {
    const fallback = VOCABULARY[tier]?.fallback
      ?? "We don't yet have enough information to assess this direction.";

    emitFallbackUsed(adapter, { capability, tier, reason });

    return fallback;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

module.exports = Object.freeze({
  createConfidenceLanguageService,
  REJECTION_CODES,  // re-exported for convenience
});
