'use strict';

/**
 * @file src/ai/confidence-language/ai-confidence-language.validator.js
 *
 * AI Confidence Language Validator — Phase 4B
 *
 * PURPOSE:
 *   Validates AI-generated narrative output against the confidence language
 *   registry. All validation is deterministic — no AI involvement.
 *
 * GOVERNANCE CONSTRAINTS:
 *   ✅ Deterministic validation — pure functions, no I/O
 *   ✅ Registry is the sole authority for allowed/prohibited vocabulary
 *   ✅ Validates AI output; never generates content itself
 *   ✅ Produces structured ValidationResult for observability and fallback
 *   ✅ Tier mismatch detection prevents confidence contradiction
 *
 * VALIDATION PIPELINE POSITION (from Phase 4B Governance Spec §5):
 *   Stage 1: Schema validation       ← upstream
 *   Stage 2: Confidence alignment    ← THIS FILE
 *   Stage 3: Hallucination scan      ← upstream / separate
 *   Stage 4: Recommendation integrity← upstream / separate
 *   Stage 5: Unsafe pattern block    ← THIS FILE (prohibited phrases)
 */

const {
  VOCABULARY,
  CONFIDENCE_TIERS,
  REGISTRY_VERSION,
} = require('./ai-confidence-language.registry');

// ─────────────────────────────────────────────────────────────────────────────
// REJECTION CODES
// Used in telemetry — must be stable identifiers (not changed between versions)
// ─────────────────────────────────────────────────────────────────────────────

const REJECTION_CODES = Object.freeze({
  UNKNOWN_TIER:          'UNKNOWN_TIER',
  PROHIBITED_PHRASE:     'PROHIBITED_PHRASE',
  TIER_ESCALATION:       'TIER_ESCALATION',
  EMPTY_OUTPUT:          'EMPTY_OUTPUT',
  EXCEEDS_MAX_LENGTH:    'EXCEEDS_MAX_LENGTH',
  BELOW_MIN_LENGTH:      'BELOW_MIN_LENGTH',
});

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const VALIDATION_CONFIG = Object.freeze({
  MIN_LENGTH:  20,    // characters — below this, output is meaningless
  MAX_LENGTH:  1000,  // characters — above this, suppress (too verbose)
});

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Case-insensitive substring match.
 * @param {string} text
 * @param {string} phrase
 * @returns {boolean}
 */
function containsPhrase(text, phrase) {
  return text.toLowerCase().includes(phrase.toLowerCase());
}

/**
 * Scans text for any phrase in a list. Returns the first match or null.
 * @param {string} text
 * @param {readonly string[]} phrases
 * @returns {{ phrase: string } | null}
 */
function findFirstMatch(text, phrases) {
  for (const phrase of phrases) {
    if (containsPhrase(text, phrase)) {
      return { phrase };
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE VALIDATOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate an AI-generated narrative against the confidence language registry.
 *
 * This is the primary Stage 2 + Stage 5 validator from the governance spec.
 * It is deterministic: same inputs → same result, no external calls.
 *
 * @param {string} narrative       — AI-generated text to validate
 * @param {string} confidenceTier  — deterministic tier from confidence.model.js
 *                                   (one of CONFIDENCE_TIERS)
 * @returns {ValidationResult}
 *
 * @typedef {Object} ValidationResult
 * @property {boolean}  valid          — true if narrative passed all checks
 * @property {string}   tier           — the tier that was validated against
 * @property {string}   registryVersion
 * @property {string[]| null} violations — rejection codes if invalid, else null
 * @property {string | null}  violationDetail — human-readable detail for logs
 * @property {string}   fallback       — the safe deterministic fallback copy
 */
function validateNarrative(narrative, confidenceTier) {
  const fallback = _getFallback(confidenceTier);

  // ── Guard: unknown tier ───────────────────────────────────────────────────
  if (!VOCABULARY[confidenceTier]) {
    return _reject(
      confidenceTier,
      fallback,
      [REJECTION_CODES.UNKNOWN_TIER],
      `Unknown confidence tier: "${confidenceTier}"`
    );
  }

  const vocab = VOCABULARY[confidenceTier];

  // ── Guard: empty or missing ───────────────────────────────────────────────
  if (!narrative || typeof narrative !== 'string' || !narrative.trim()) {
    return _reject(
      confidenceTier,
      fallback,
      [REJECTION_CODES.EMPTY_OUTPUT],
      'AI narrative is empty or missing'
    );
  }

  const text = narrative.trim();

  // ── Stage 1 extension: length bounds ─────────────────────────────────────
  if (text.length < VALIDATION_CONFIG.MIN_LENGTH) {
    return _reject(
      confidenceTier,
      fallback,
      [REJECTION_CODES.BELOW_MIN_LENGTH],
      `Narrative too short: ${text.length} chars (min ${VALIDATION_CONFIG.MIN_LENGTH})`
    );
  }

  if (text.length > VALIDATION_CONFIG.MAX_LENGTH) {
    return _reject(
      confidenceTier,
      fallback,
      [REJECTION_CODES.EXCEEDS_MAX_LENGTH],
      `Narrative too long: ${text.length} chars (max ${VALIDATION_CONFIG.MAX_LENGTH})`
    );
  }

  // ── Stage 5: Prohibited phrase detection (within-tier) ───────────────────
  const prohibitedMatch = findFirstMatch(text, vocab.prohibited);

  if (prohibitedMatch) {
    return _reject(
      confidenceTier,
      fallback,
      [REJECTION_CODES.PROHIBITED_PHRASE],
      `Prohibited phrase detected for tier ${confidenceTier}: "${prohibitedMatch.phrase}"`
    );
  }

  // ── Stage 2: Cross-tier escalation detection ─────────────────────────────
  // Checks whether the narrative uses language that belongs to a HIGHER-
  // confidence tier than the deterministic output supports.
  const escalationViolation = _detectTierEscalation(text, confidenceTier);

  if (escalationViolation) {
    return _reject(
      confidenceTier,
      fallback,
      [REJECTION_CODES.TIER_ESCALATION],
      `Confidence escalation: found "${escalationViolation.phrase}" ` +
      `(${escalationViolation.sourceTier} language) in a ${confidenceTier} narrative`
    );
  }

  // ── All checks passed ─────────────────────────────────────────────────────
  return Object.freeze({
    valid:            true,
    tier:             confidenceTier,
    registryVersion:  REGISTRY_VERSION.version,
    violations:       null,
    violationDetail:  null,
    fallback,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CROSS-TIER ESCALATION DETECTION
//
// For each tier, we check whether the narrative contains phrases that are
// exclusively used in a higher-confidence tier. This catches cases where AI
// uses HIGH language in a MEDIUM or LOW output, or MEDIUM language in LOW.
//
// Escalation hierarchy: HIGH > MEDIUM > LOW > NO_DATA
// ─────────────────────────────────────────────────────────────────────────────

const _ESCALATION_MAP = Object.freeze({
  // If we are at MEDIUM, detect HIGH-exclusive phrases
  [CONFIDENCE_TIERS.MEDIUM]: Object.freeze({
    checkTier:  CONFIDENCE_TIERS.HIGH,
    // HIGH phrases that are not in MEDIUM.allowed
    escalatingPhrases: _escalatingPhrasesFor(CONFIDENCE_TIERS.HIGH, CONFIDENCE_TIERS.MEDIUM),
  }),
  // If we are at LOW, detect HIGH or MEDIUM exclusive phrases
  [CONFIDENCE_TIERS.LOW]: Object.freeze({
    checkTier: CONFIDENCE_TIERS.HIGH,
    escalatingPhrases: _escalatingPhrasesFor(CONFIDENCE_TIERS.HIGH, CONFIDENCE_TIERS.LOW),
  }),
  // If we are at NO_DATA, detect any capability-claiming language
  [CONFIDENCE_TIERS.NO_DATA]: Object.freeze({
    checkTier: CONFIDENCE_TIERS.LOW,
    escalatingPhrases: _escalatingPhrasesFor(CONFIDENCE_TIERS.LOW, CONFIDENCE_TIERS.NO_DATA),
  }),
  // HIGH tier has no higher tier to escalate to
  [CONFIDENCE_TIERS.HIGH]: Object.freeze({
    checkTier: null,
    escalatingPhrases: Object.freeze([]),
  }),
});

/**
 * Returns phrases that are in the allowed list of `higherTier` but NOT in
 * the allowed list of `currentTier`. These are the phrases that would
 * represent a confidence escalation.
 *
 * NOTE: Called at module load time (not per-validation), so O(n) is fine.
 *
 * @param {string} higherTier
 * @param {string} currentTier
 * @returns {readonly string[]}
 */
function _escalatingPhrasesFor(higherTier, currentTier) {
  const higherAllowed  = new Set(VOCABULARY[higherTier]?.allowed  ?? []);
  const currentAllowed = new Set(VOCABULARY[currentTier]?.allowed ?? []);
  const result = [];

  for (const phrase of higherAllowed) {
    if (!currentAllowed.has(phrase)) {
      result.push(phrase);
    }
  }

  return Object.freeze(result);
}

/**
 * Checks narrative text for escalation phrases appropriate to a higher tier.
 *
 * @param {string} text
 * @param {string} confidenceTier
 * @returns {{ phrase: string, sourceTier: string } | null}
 */
function _detectTierEscalation(text, confidenceTier) {
  const entry = _ESCALATION_MAP[confidenceTier];
  if (!entry || !entry.escalatingPhrases.length) return null;

  const match = findFirstMatch(text, entry.escalatingPhrases);
  if (!match) return null;

  return { phrase: match.phrase, sourceTier: entry.checkTier };
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function _getFallback(tier) {
  return VOCABULARY[tier]?.fallback ?? "We don't yet have enough information to assess this direction.";
}

function _reject(tier, fallback, violations, detail) {
  return Object.freeze({
    valid:           false,
    tier,
    registryVersion: REGISTRY_VERSION.version,
    violations,
    violationDetail: detail,
    fallback,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// BATCH VALIDATOR
// For use in observability sampling and test harnesses.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate multiple narratives at once.
 *
 * @param {Array<{ narrative: string, tier: string }>} items
 * @returns {ValidationResult[]}
 */
function validateBatch(items) {
  if (!Array.isArray(items)) return [];
  return items.map(({ narrative, tier }) => validateNarrative(narrative, tier));
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

module.exports = Object.freeze({
  REJECTION_CODES,
  VALIDATION_CONFIG,
  validateNarrative,
  validateBatch,
});
