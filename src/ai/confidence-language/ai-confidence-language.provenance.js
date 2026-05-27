'use strict';

/**
 * @file src/ai/confidence-language/ai-confidence-language.provenance.js
 *
 * Phrase Match Provenance Tracking — Phase 4B Governance Hardening
 *
 * PURPOSE:
 *   When validator rules trigger, capture deterministic provenance metadata
 *   for governance debugging, validator tuning, false-positive analysis,
 *   and auditability.
 *
 * GOVERNANCE CONSTRAINTS:
 *   ✅ Deterministic metadata extraction only — no content generation
 *   ✅ Immutable provenance payloads (Object.freeze)
 *   ✅ Append-only observability structure — payloads are never mutated
 *   ✅ Privacy-safe — no raw AI output, no prompt text, no user PII
 *   ✅ Does NOT alter validation outcomes — pure side-channel metadata
 *
 * ARCHITECTURE POSITION:
 *   validator.js → [this module] → telemetry adapter → observability store
 *
 * PAYLOAD SCHEMA (see buildProvenancePayload):
 *   violationType      — which rule triggered
 *   matchedPhrase      — the exact phrase that matched
 *   detectedTier       — the tier present in AI output
 *   expectedTier       — the tier the deterministic engine required
 *   validatorStage     — which stage caught the violation
 *   capability         — the AI augmentation capability (e.g. 'recommendation_narrative')
 *   promptVersion      — semantic version from the prompt registry
 *   timestamp          — ISO 8601 at emission time
 */

const { REGISTRY_VERSION } = require('./ai-confidence-language.registry');

// ─────────────────────────────────────────────────────────────────────────────
// VIOLATION TYPES
// Stable identifiers — do not rename between registry versions.
// ─────────────────────────────────────────────────────────────────────────────

const VIOLATION_TYPES = Object.freeze({
  PROHIBITED_PHRASE:      'prohibited_phrase',
  CROSS_TIER_ESCALATION:  'cross_tier_escalation',
  EMPTY_OUTPUT:           'empty_output',
  BELOW_MIN_LENGTH:       'below_min_length',
  EXCEEDS_MAX_LENGTH:     'exceeds_max_length',
  UNKNOWN_TIER:           'unknown_tier',
});

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATOR STAGE IDENTIFIERS
// Must align with stage labels in the governance spec §5 pipeline.
// ─────────────────────────────────────────────────────────────────────────────

const VALIDATOR_STAGES = Object.freeze({
  SCHEMA:                 'schema_validation',
  CONFIDENCE_ALIGNMENT:   'confidence_alignment',
  HALLUCINATION_SCAN:     'hallucination_scan',
  RECOMMENDATION_INTEGRITY: 'recommendation_integrity',
  UNSAFE_PATTERN:         'unsafe_pattern_block',
  LENGTH_BOUNDS:          'length_bounds',
});

// ─────────────────────────────────────────────────────────────────────────────
// REJECTION CODE → VIOLATION TYPE MAPPING
// Translates validator rejection codes to provenance vocabulary.
// ─────────────────────────────────────────────────────────────────────────────

const REJECTION_CODE_TO_VIOLATION = Object.freeze({
  PROHIBITED_PHRASE:    VIOLATION_TYPES.PROHIBITED_PHRASE,
  TIER_ESCALATION:      VIOLATION_TYPES.CROSS_TIER_ESCALATION,
  EMPTY_OUTPUT:         VIOLATION_TYPES.EMPTY_OUTPUT,
  BELOW_MIN_LENGTH:     VIOLATION_TYPES.BELOW_MIN_LENGTH,
  EXCEEDS_MAX_LENGTH:   VIOLATION_TYPES.EXCEEDS_MAX_LENGTH,
  UNKNOWN_TIER:         VIOLATION_TYPES.UNKNOWN_TIER,
});

// ─────────────────────────────────────────────────────────────────────────────
// REJECTION CODE → VALIDATOR STAGE MAPPING
// ─────────────────────────────────────────────────────────────────────────────

const REJECTION_CODE_TO_STAGE = Object.freeze({
  PROHIBITED_PHRASE:    VALIDATOR_STAGES.UNSAFE_PATTERN,
  TIER_ESCALATION:      VALIDATOR_STAGES.CONFIDENCE_ALIGNMENT,
  EMPTY_OUTPUT:         VALIDATOR_STAGES.SCHEMA,
  BELOW_MIN_LENGTH:     VALIDATOR_STAGES.LENGTH_BOUNDS,
  EXCEEDS_MAX_LENGTH:   VALIDATOR_STAGES.LENGTH_BOUNDS,
  UNKNOWN_TIER:         VALIDATOR_STAGES.SCHEMA,
});

// ─────────────────────────────────────────────────────────────────────────────
// PROVENANCE PAYLOAD BUILDER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build an immutable provenance payload from a validator rejection event.
 *
 * This function is the single source of truth for provenance schema.
 * Called by the service layer after a ValidationResult with valid=false.
 *
 * @param {Object} params
 * @param {string}   params.rejectionCode   — single REJECTION_CODES value
 * @param {string}   params.matchedPhrase   — phrase that triggered the rule
 *                                            (empty string for non-phrase violations)
 * @param {string}   params.detectedTier    — the tier in the AI output (may be wrong)
 * @param {string}   params.expectedTier    — the tier the engine required
 * @param {string}   params.capability      — AI augmentation capability identifier
 * @param {string}   params.promptVersion   — from prompt registry (e.g. '1.0.0')
 *
 * @returns {ProvenancePayload} — frozen, privacy-safe, ready for telemetry
 *
 * @typedef {Object} ProvenancePayload
 * @property {string} violationType
 * @property {string} matchedPhrase
 * @property {string} detectedTier
 * @property {string} expectedTier
 * @property {string} validatorStage
 * @property {string} capability
 * @property {string} promptVersion
 * @property {string} registryVersion
 * @property {string} timestamp
 */
function buildProvenancePayload({
  rejectionCode,
  matchedPhrase = '',
  detectedTier,
  expectedTier,
  capability,
  promptVersion,
}) {
  const violationType  = REJECTION_CODE_TO_VIOLATION[rejectionCode] ?? rejectionCode.toLowerCase();
  const validatorStage = REJECTION_CODE_TO_STAGE[rejectionCode]     ?? VALIDATOR_STAGES.SCHEMA;

  return Object.freeze({
    violationType,
    matchedPhrase:    String(matchedPhrase),   // never raw AI content — only the matched phrase token
    detectedTier:     String(detectedTier  ?? 'UNKNOWN'),
    expectedTier:     String(expectedTier  ?? detectedTier ?? 'UNKNOWN'),
    validatorStage,
    capability:       String(capability    ?? 'unknown'),
    promptVersion:    String(promptVersion ?? 'unversioned'),
    registryVersion:  REGISTRY_VERSION.version,
    timestamp:        new Date().toISOString(),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// BATCH PROVENANCE BUILDER
// For cases where a single validation produces multiple violation codes.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build provenance payloads for all violations in a ValidationResult.
 *
 * @param {Object} validationResult  — from validateNarrative()
 * @param {Object} context
 * @param {string} context.capability
 * @param {string} context.promptVersion
 * @param {string} [context.matchedPhrase='']
 * @returns {ProvenancePayload[]}
 */
function buildProvenancePayloads(validationResult, context) {
  if (validationResult.valid || !Array.isArray(validationResult.violations)) {
    return [];
  }

  return validationResult.violations.map((rejectionCode) =>
    buildProvenancePayload({
      rejectionCode,
      matchedPhrase:  context.matchedPhrase ?? '',
      detectedTier:   validationResult.tier,
      expectedTier:   validationResult.tier,    // tier is the expected tier from the engine
      capability:     context.capability,
      promptVersion:  context.promptVersion,
    })
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CROSS-TIER PROVENANCE BUILDER
// Specific builder for cross-tier escalation — carries the source (escalating) tier.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build provenance for a cross-tier escalation event specifically.
 * The escalationDetail comes from _detectTierEscalation internals.
 *
 * @param {Object} params
 * @param {string} params.matchedPhrase   — the escalating phrase found in the narrative
 * @param {string} params.detectedTier    — the higher tier whose language appeared
 * @param {string} params.expectedTier    — the tier the engine actually required
 * @param {string} params.capability
 * @param {string} params.promptVersion
 * @returns {ProvenancePayload}
 */
function buildCrossTierProvenance({
  matchedPhrase,
  detectedTier,
  expectedTier,
  capability,
  promptVersion,
}) {
  return Object.freeze({
    violationType:   VIOLATION_TYPES.CROSS_TIER_ESCALATION,
    matchedPhrase:   String(matchedPhrase ?? ''),
    detectedTier:    String(detectedTier  ?? 'UNKNOWN'),
    expectedTier:    String(expectedTier  ?? 'UNKNOWN'),
    validatorStage:  VALIDATOR_STAGES.CONFIDENCE_ALIGNMENT,
    capability:      String(capability    ?? 'unknown'),
    promptVersion:   String(promptVersion ?? 'unversioned'),
    registryVersion: REGISTRY_VERSION.version,
    timestamp:       new Date().toISOString(),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PAYLOAD INTEGRITY VALIDATOR
// Used in tests to assert well-formed provenance payloads.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verifies that a provenance payload has all required fields and correct types.
 * Returns an array of field-level errors (empty = valid).
 *
 * @param {unknown} payload
 * @returns {string[]} errors
 */
function validateProvenancePayload(payload) {
  const errors = [];

  if (!payload || typeof payload !== 'object') {
    return ['payload must be a non-null object'];
  }

  const required = [
    'violationType',
    'matchedPhrase',
    'detectedTier',
    'expectedTier',
    'validatorStage',
    'capability',
    'promptVersion',
    'registryVersion',
    'timestamp',
  ];

  for (const field of required) {
    if (typeof payload[field] !== 'string' || payload[field].length === 0) {
      // matchedPhrase is allowed to be empty string (non-phrase violations)
      if (field === 'matchedPhrase') continue;
      errors.push(`field "${field}" must be a non-empty string`);
    }
  }

  // Timestamp must be ISO 8601
  if (payload.timestamp && isNaN(Date.parse(payload.timestamp))) {
    errors.push('field "timestamp" must be a valid ISO 8601 string');
  }

  // violationType must be a known value
  const knownTypes = new Set(Object.values(VIOLATION_TYPES));
  if (payload.violationType && !knownTypes.has(payload.violationType)) {
    errors.push(`field "violationType" "${payload.violationType}" is not a known VIOLATION_TYPES value`);
  }

  return errors;
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

module.exports = Object.freeze({
  VIOLATION_TYPES,
  VALIDATOR_STAGES,
  REJECTION_CODE_TO_VIOLATION,
  REJECTION_CODE_TO_STAGE,
  buildProvenancePayload,
  buildProvenancePayloads,
  buildCrossTierProvenance,
  validateProvenancePayload,
});
