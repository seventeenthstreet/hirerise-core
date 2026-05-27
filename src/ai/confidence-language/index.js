'use strict';

/**
 * @file src/ai/confidence-language/index.js
 *
 * Barrel export for the AI Confidence Language module.
 *
 * Consumers should import from this index — never from individual files —
 * to maintain clean dependency boundaries.
 *
 * Usage:
 *   const {
 *     CONFIDENCE_TIERS,
 *     VOCABULARY,
 *     createConfidenceLanguageService,
 *   } = require('./ai/confidence-language');
 */

const registry = require('./ai-confidence-language.registry');
const { validateNarrative, validateBatch, REJECTION_CODES, VALIDATION_CONFIG } =
  require('./ai-confidence-language.validator');
const { createConfidenceLanguageService } =
  require('./ai-confidence-language.service');
const { TELEMETRY_EVENTS } =
  require('./ai-confidence-language.telemetry');

// Phase 4B — Governance Hardening additions
const provenance = require('./ai-confidence-language.provenance');
const metrics    = require('./ai-confidence-language.metrics');
const observability = require('./ai-validation-observability');

module.exports = Object.freeze({
  // Registry
  CONFIDENCE_TIERS:              registry.CONFIDENCE_TIERS,
  VOCABULARY:                    registry.VOCABULARY,
  REGISTRY_VERSION:              registry.REGISTRY_VERSION,
  getPromptGroundingInstructions: registry.getPromptGroundingInstructions,

  // Validator
  validateNarrative,
  validateBatch,
  REJECTION_CODES,
  VALIDATION_CONFIG,

  // Service (factory)
  createConfidenceLanguageService,

  // Telemetry event names (for test assertions / admin tooling)
  TELEMETRY_EVENTS,

  // Phase 4B — Phrase Match Provenance
  VIOLATION_TYPES:              provenance.VIOLATION_TYPES,
  VALIDATOR_STAGES:             provenance.VALIDATOR_STAGES,
  buildProvenancePayload:       provenance.buildProvenancePayload,
  buildProvenancePayloads:      provenance.buildProvenancePayloads,
  buildCrossTierProvenance:     provenance.buildCrossTierProvenance,
  validateProvenancePayload:    provenance.validateProvenancePayload,

  // Phase 4B — Narrative Suppression Metrics
  METRIC_NAMES:                 metrics.METRIC_NAMES,
  recordValidationAttempt:      metrics.recordValidationAttempt,
  recordViolation:              metrics.recordViolation,
  recordFallback:               metrics.recordFallback,
  getMetricsSnapshot:           metrics.getMetricsSnapshot,
  getCapabilityMetrics:         metrics.getCapabilityMetrics,
  getRollupTotals:              metrics.getRollupTotals,

  // Phase 4B — Observability Integration
  VALIDATION_OBSERVABILITY_EVENTS: observability.VALIDATION_OBSERVABILITY_EVENTS,
  emitProvenanceLogged:            observability.emitProvenanceLogged,
  emitSuppressed:                  observability.emitSuppressed,
  emitCrossTierDetected:           observability.emitCrossTierDetected,
  emitProhibitedPhraseDetected:    observability.emitProhibitedPhraseDetected,
  emitFallbackTriggered:           observability.emitFallbackTriggered,
  emitPromptValidationFailed:      observability.emitPromptValidationFailed,
  emitValidationApproved:          observability.emitValidationApproved,
});
