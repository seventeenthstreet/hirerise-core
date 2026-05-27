'use strict';

/**
 * @file src/ai/confidence-language/ai-confidence-language.telemetry.js
 *
 * AI Confidence Language Telemetry — Phase 4B
 *
 * PURPOSE:
 *   Emits governance-safe observability events for confidence language
 *   validation outcomes. Integrates with the existing ObservabilityAdapter
 *   pattern — no new monitoring infrastructure.
 *
 * GOVERNANCE CONSTRAINTS:
 *   ✅ Modular telemetry — injected adapter, no direct PostHog/Supabase calls
 *   ✅ Privacy-safe — no raw AI output, no user content, no PII in logs
 *   ✅ No orchestration coupling — emitter is fire-and-forget
 *   ✅ All emission is non-blocking — never throws into calling code
 *
 * EVENT NAMES (stable — do not rename between versions):
 *   ai.confidence_language.applied
 *   ai.confidence_language.rejected
 *   ai.confidence_language.fallback_used
 *   ai.confidence_language.violation_detected
 */

const { REGISTRY_VERSION } = require('./ai-confidence-language.registry');

// ─────────────────────────────────────────────────────────────────────────────
// EVENT NAME CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const TELEMETRY_EVENTS = Object.freeze({
  APPLIED:            'ai.confidence_language.applied',
  REJECTED:           'ai.confidence_language.rejected',
  FALLBACK_USED:      'ai.confidence_language.fallback_used',
  VIOLATION_DETECTED: 'ai.confidence_language.violation_detected',
});

// ─────────────────────────────────────────────────────────────────────────────
// SAFE EMIT WRAPPER
// Never throws. Adapter failures are silently swallowed to protect the
// AI augmentation render path.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {Object} adapter — ObservabilityAdapter instance (injected)
 * @param {string} eventName
 * @param {Object} payload
 */
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
// TELEMETRY EMITTERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Emitted when AI narrative passes validation and is rendered to the user.
 *
 * @param {Object} adapter
 * @param {Object} params
 * @param {string} params.capability   — e.g. 'explanation_enhancement'
 * @param {string} params.tier         — CONFIDENCE_TIERS value
 * @param {string} params.promptId     — from prompt registry
 * @param {string} params.promptVersion
 */
function emitApplied(adapter, { capability, tier, promptId, promptVersion }) {
  _safeEmit(adapter, TELEMETRY_EVENTS.APPLIED, {
    capability,
    tier,
    promptId,
    promptVersion,
    registryVersion: REGISTRY_VERSION.version,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Emitted when AI narrative fails validation and is suppressed.
 * Raw AI output is never logged — only the rejection metadata.
 *
 * @param {Object} adapter
 * @param {Object} params
 * @param {string} params.capability
 * @param {string} params.tier
 * @param {string} params.promptId
 * @param {string[]} params.violations  — REJECTION_CODES array
 */
function emitRejected(adapter, { capability, tier, promptId, violations }) {
  _safeEmit(adapter, TELEMETRY_EVENTS.REJECTED, {
    capability,
    tier,
    promptId,
    violations,
    registryVersion: REGISTRY_VERSION.version,
    timestamp: new Date().toISOString(),
    // NOTE: no raw narrative, no user data
  });
}

/**
 * Emitted when fallback copy is rendered in place of AI narrative.
 *
 * @param {Object} adapter
 * @param {Object} params
 * @param {string} params.capability
 * @param {string} params.tier
 * @param {string} params.reason  — why fallback was used (e.g. 'validation_failed', 'ai_timeout', 'flag_off')
 */
function emitFallbackUsed(adapter, { capability, tier, reason }) {
  _safeEmit(adapter, TELEMETRY_EVENTS.FALLBACK_USED, {
    capability,
    tier,
    reason,
    registryVersion: REGISTRY_VERSION.version,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Emitted once per violation type detected. Used for governance dashboards.
 * May be called multiple times in one validation pass (once per violation code).
 *
 * @param {Object} adapter
 * @param {Object} params
 * @param {string} params.capability
 * @param {string} params.tier
 * @param {string} params.violationCode  — single REJECTION_CODES value
 */
function emitViolationDetected(adapter, { capability, tier, violationCode }) {
  _safeEmit(adapter, TELEMETRY_EVENTS.VIOLATION_DETECTED, {
    capability,
    tier,
    violationCode,
    registryVersion: REGISTRY_VERSION.version,
    timestamp: new Date().toISOString(),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

module.exports = Object.freeze({
  TELEMETRY_EVENTS,
  emitApplied,
  emitRejected,
  emitFallbackUsed,
  emitViolationDetected,
});
