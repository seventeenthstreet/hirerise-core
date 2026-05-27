'use strict';

/**
 * @file src/ai/confidence-language/ai-validation-observability.js
 *
 * Validation Observability Integration — Phase 4B Governance Hardening
 *
 * PURPOSE:
 *   Extends the existing telemetry architecture with Phase 4B governance events.
 *   Integrates phrase provenance, suppression metrics, and prompt validation
 *   outcomes into the ObservabilityAdapter pattern.
 *
 * GOVERNANCE CONSTRAINTS:
 *   ✅ Adapter-based — no direct PostHog/Supabase/logging vendor coupling
 *   ✅ Fire-and-forget — telemetry never blocks the render path
 *   ✅ No raw AI output logged — only metadata (phrase tokens, tier, codes)
 *   ✅ AI modules do NOT self-report quality — this layer is external to the AI call
 *   ✅ Observability failure is always silent — never throws into calling code
 *
 * NEW TELEMETRY EVENTS (Phase 4B):
 *   ai.validation.provenance_logged
 *   ai.validation.suppressed
 *   ai.validation.cross_tier_detected
 *   ai.validation.prohibited_phrase_detected
 *   ai.validation.fallback_triggered
 *   ai.prompt.validation_failed
 *
 * EXISTING EVENTS (Phase 4A — preserved, not modified):
 *   ai.confidence_language.applied
 *   ai.confidence_language.rejected
 *   ai.confidence_language.fallback_used
 *   ai.confidence_language.violation_detected
 */

const { REGISTRY_VERSION }             = require('./ai-confidence-language.registry');
const { recordValidationAttempt,
        recordViolation,
        recordFallback }               = require('./ai-confidence-language.metrics');

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4B TELEMETRY EVENT NAMES
// These extend (not replace) the Phase 4A TELEMETRY_EVENTS in telemetry.js.
// ─────────────────────────────────────────────────────────────────────────────

const VALIDATION_OBSERVABILITY_EVENTS = Object.freeze({
  PROVENANCE_LOGGED:          'ai.validation.provenance_logged',
  SUPPRESSED:                 'ai.validation.suppressed',
  CROSS_TIER_DETECTED:        'ai.validation.cross_tier_detected',
  PROHIBITED_PHRASE_DETECTED: 'ai.validation.prohibited_phrase_detected',
  FALLBACK_TRIGGERED:         'ai.validation.fallback_triggered',
  PROMPT_VALIDATION_FAILED:   'ai.prompt.validation_failed',
});

// ─────────────────────────────────────────────────────────────────────────────
// SAFE EMIT WRAPPER (local — consistent with telemetry.js pattern)
// ─────────────────────────────────────────────────────────────────────────────

function _safeEmit(adapter, eventName, payload) {
  try {
    if (adapter && typeof adapter.emit === 'function') {
      adapter.emit(eventName, payload);
    }
  } catch (_err) {
    // Observability must never disrupt the render path
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4B EMITTERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Emit a provenance logging event.
 * Called after buildProvenancePayload() produces a provenance record.
 *
 * @param {Object} adapter
 * @param {import('./ai-confidence-language.provenance').ProvenancePayload} provenancePayload
 */
function emitProvenanceLogged(adapter, provenancePayload) {
  _safeEmit(adapter, VALIDATION_OBSERVABILITY_EVENTS.PROVENANCE_LOGGED, {
    ...provenancePayload,
    // provenancePayload is already privacy-safe and frozen
    registryVersion: REGISTRY_VERSION.version,
  });
}

/**
 * Emit a narrative suppression event.
 * Called when AI output is rejected and replaced by fallback copy.
 *
 * @param {Object} adapter
 * @param {Object} params
 * @param {string} params.capability
 * @param {string} params.tier
 * @param {string} params.promptVersion
 * @param {string[]} params.violations   — REJECTION_CODES values
 * @param {string} params.validatorStage
 */
function emitSuppressed(adapter, { capability, tier, promptVersion, violations, validatorStage }) {
  _safeEmit(adapter, VALIDATION_OBSERVABILITY_EVENTS.SUPPRESSED, {
    capability,
    tier,
    promptVersion,
    violations,
    validatorStage,
    registryVersion: REGISTRY_VERSION.version,
    timestamp:       new Date().toISOString(),
  });

  // Mirror into metrics store
  try {
    recordValidationAttempt({
      capability,
      confidenceTier: tier,
      promptVersion,
      validatorStage,
      suppressed:     true,
      fallbackUsed:   true,
    });
  } catch (_err) {
    // Metrics recording never throws into calling code
  }
}

/**
 * Emit a cross-tier escalation detection event.
 *
 * @param {Object} adapter
 * @param {Object} params
 * @param {string} params.capability
 * @param {string} params.matchedPhrase
 * @param {string} params.detectedTier
 * @param {string} params.expectedTier
 * @param {string} params.promptVersion
 */
function emitCrossTierDetected(adapter, { capability, matchedPhrase, detectedTier, expectedTier, promptVersion }) {
  _safeEmit(adapter, VALIDATION_OBSERVABILITY_EVENTS.CROSS_TIER_DETECTED, {
    capability,
    matchedPhrase,        // phrase token only — not raw AI narrative
    detectedTier,
    expectedTier,
    promptVersion,
    registryVersion: REGISTRY_VERSION.version,
    timestamp:       new Date().toISOString(),
  });

  // Mirror into metrics store
  try {
    recordViolation({
      capability,
      confidenceTier: expectedTier,
      promptVersion,
      validatorStage: 'confidence_alignment',
      failureType:    'cross_tier_escalation',
    });
  } catch (_err) {
    // ignore
  }
}

/**
 * Emit a prohibited phrase detection event.
 *
 * @param {Object} adapter
 * @param {Object} params
 * @param {string} params.capability
 * @param {string} params.matchedPhrase
 * @param {string} params.tier
 * @param {string} params.promptVersion
 */
function emitProhibitedPhraseDetected(adapter, { capability, matchedPhrase, tier, promptVersion }) {
  _safeEmit(adapter, VALIDATION_OBSERVABILITY_EVENTS.PROHIBITED_PHRASE_DETECTED, {
    capability,
    matchedPhrase,       // phrase token only
    tier,
    promptVersion,
    registryVersion: REGISTRY_VERSION.version,
    timestamp:       new Date().toISOString(),
  });

  // Mirror into metrics store
  try {
    recordViolation({
      capability,
      confidenceTier: tier,
      promptVersion,
      validatorStage: 'unsafe_pattern_block',
      failureType:    'prohibited_phrase',
    });
  } catch (_err) {
    // ignore
  }
}

/**
 * Emit a fallback triggered event.
 * Covers all fallback scenarios: validation fail, AI timeout, flag off.
 *
 * @param {Object} adapter
 * @param {Object} params
 * @param {string} params.capability
 * @param {string} params.tier
 * @param {string} params.promptVersion
 * @param {string} params.reason         — e.g. 'validation_failed', 'ai_timeout', 'flag_off'
 */
function emitFallbackTriggered(adapter, { capability, tier, promptVersion, reason }) {
  _safeEmit(adapter, VALIDATION_OBSERVABILITY_EVENTS.FALLBACK_TRIGGERED, {
    capability,
    tier,
    promptVersion,
    reason,
    registryVersion: REGISTRY_VERSION.version,
    timestamp:       new Date().toISOString(),
  });

  // Mirror into metrics store
  try {
    recordFallback({ capability, confidenceTier: tier, promptVersion, reason });
  } catch (_err) {
    // ignore
  }
}

/**
 * Emit a prompt validation failure event (pre-deployment gate).
 * Called by CI/CD or admin tooling when validatePrompt() returns invalid.
 *
 * @param {Object} adapter
 * @param {Object} params
 * @param {string}   params.promptId
 * @param {string}   params.promptVersion
 * @param {string[]} params.missingInstructions
 * @param {Object[]} params.forbiddenMatches
 * @param {string[]} params.errors
 */
function emitPromptValidationFailed(adapter, {
  promptId,
  promptVersion,
  missingInstructions,
  forbiddenMatches,
  errors,
}) {
  _safeEmit(adapter, VALIDATION_OBSERVABILITY_EVENTS.PROMPT_VALIDATION_FAILED, {
    promptId,
    promptVersion,
    missingInstructions,
    forbiddenMatchCount: Array.isArray(forbiddenMatches) ? forbiddenMatches.length : 0,
    forbiddenLabels:     Array.isArray(forbiddenMatches) ? forbiddenMatches.map((m) => m.label) : [],
    errorCount:          Array.isArray(errors) ? errors.length : 0,
    registryVersion:     REGISTRY_VERSION.version,
    timestamp:           new Date().toISOString(),
    // NOTE: no prompt text — only structural metadata
  });
}

/**
 * Emit a successful validation event (narrative approved, no suppression).
 * Mirrors the metrics store increment for a passing validation.
 *
 * @param {Object} adapter
 * @param {Object} params
 * @param {string} params.capability
 * @param {string} params.tier
 * @param {string} params.promptVersion
 * @param {string} params.validatorStage
 */
function emitValidationApproved(adapter, { capability, tier, promptVersion, validatorStage = 'unknown' }) {
  // Mirror into metrics store (no render-path event needed for success — telemetry.js covers APPLIED)
  try {
    recordValidationAttempt({
      capability,
      confidenceTier: tier,
      promptVersion,
      validatorStage,
      suppressed:    false,
      fallbackUsed:  false,
    });
  } catch (_err) {
    // ignore
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

module.exports = Object.freeze({
  VALIDATION_OBSERVABILITY_EVENTS,
  emitProvenanceLogged,
  emitSuppressed,
  emitCrossTierDetected,
  emitProhibitedPhraseDetected,
  emitFallbackTriggered,
  emitPromptValidationFailed,
  emitValidationApproved,
});
