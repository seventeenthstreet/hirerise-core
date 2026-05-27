'use strict';

/**
 * @file src/ai/prompt-registry/ai-prompt-registry.validator.js
 *
 * Prompt Registry Validation — Phase 4B Governance Hardening
 *
 * PURPOSE:
 *   Ensures all registered prompts comply with governance rules before deployment.
 *   Validates that prompts include required governance instructions and do not
 *   contain forbidden patterns that would violate HireRise's deterministic
 *   authority model.
 *
 * GOVERNANCE CONSTRAINTS:
 *   ✅ Deterministic — pure static analysis, no AI involvement, no I/O
 *   ✅ Static-analysis-based — pattern matching and instruction presence checks only
 *   ✅ Pre-deployment-safe — designed to run in CI/CD, not on the hot request path
 *   ✅ Runtime-independent — can run without DB, Redis, or any service dependency
 *   ✅ Prompt validation failure blocks deployment; it does NOT block runtime rendering
 *
 * VALIDATION PIPELINE:
 *   1. Required instruction presence — does the prompt include governance anchors?
 *   2. Forbidden pattern detection  — does the prompt contain authority-violating instructions?
 *   3. Prompt version enforcement    — does the prompt declare a valid semantic version?
 *   4. Registry integrity validation — does the registry have no duplicate IDs?
 *
 * REQUIRED GOVERNANCE INSTRUCTIONS (prompts MUST contain these concepts):
 *   - confidence grounding instructions
 *   - prohibited phrase enforcement
 *   - deterministic authority restrictions
 *   - recommendation ordering restrictions
 *   - hallucination prevention instructions
 *
 * FORBIDDEN PATTERNS (prompts MUST NOT contain these):
 *   - "decide" (AI claiming decision authority)
 *   - "rank candidates" (AI claiming ranking authority)
 *   - "best fit" (unqualified superlative)
 *   - "guaranteed success" (certainty overclaim)
 *   - "perfect career" (superlative overclaim)
 */

// ─────────────────────────────────────────────────────────────────────────────
// REQUIRED GOVERNANCE INSTRUCTION MARKERS
//
// Each entry is a { label, patterns[] } where at least one pattern from the
// list must appear in the prompt text (case-insensitive substring match).
// ─────────────────────────────────────────────────────────────────────────────

const REQUIRED_GOVERNANCE_MARKERS = Object.freeze([
  Object.freeze({
    label:    'confidence_grounding',
    description: 'Prompt must include confidence tier grounding instructions',
    patterns: Object.freeze([
      'confidence tier',
      'confidence level',
      'confidence grounding',
      'confidence tiers',
      'high confidence',
      'low confidence',
      'medium confidence',
      'no_data',
      'uncertainty',
    ]),
  }),
  Object.freeze({
    label:    'prohibited_phrase_enforcement',
    description: 'Prompt must reference prohibited phrase restrictions',
    patterns: Object.freeze([
      'prohibited',
      'do not use',
      'never use',
      'avoid',
      'forbidden',
      'not allowed',
      'must not',
      'do not say',
    ]),
  }),
  Object.freeze({
    label:    'deterministic_authority_restriction',
    description: 'Prompt must defer scoring/authority to deterministic systems',
    patterns: Object.freeze([
      'do not score',
      'do not rank',
      'do not calculate',
      'deterministic',
      'provided score',
      'input data',
      'derived from',
      'based on the data',
      'do not invent',
      'never invented',
      'scoring is determined',
      'ranking is determined',
    ]),
  }),
  Object.freeze({
    label:    'recommendation_ordering_restriction',
    description: 'Prompt must not grant AI authority over recommendation order',
    patterns: Object.freeze([
      'order is determined',
      'do not reorder',
      'ordering is fixed',
      'do not alter order',
      'do not change the order',
      'recommendation order',
      'follow the provided',
      'use the provided order',
      // Also accept prompts that acknowledge the AI doesn't produce recommendations directly
      'do not produce recommendations',
      'you do not determine',
      'not responsible for ranking',
    ]),
  }),
  Object.freeze({
    label:    'hallucination_prevention',
    description: 'Prompt must include explicit anti-hallucination instructions',
    patterns: Object.freeze([
      'do not invent',
      'never invent',
      'must not fabricate',
      'no fabrication',
      'grounded in',
      'evidence-based',
      'must be derived',
      'only use the provided',
      'strictly from the input',
      'do not guess',
      'must not assume',
    ]),
  }),
]);

// ─────────────────────────────────────────────────────────────────────────────
// FORBIDDEN PATTERNS
//
// Prompts MUST NOT contain these patterns. Each is a { label, pattern, reason }.
// ─────────────────────────────────────────────────────────────────────────────

const FORBIDDEN_PROMPT_PATTERNS = Object.freeze([
  Object.freeze({
    label:   'authority_decide',
    pattern: 'decide',
    reason:  'AI must not claim decision authority — decisions are deterministic engine outputs',
  }),
  Object.freeze({
    label:   'rank_candidates',
    pattern: 'rank candidates',
    reason:  'Candidate ranking is a deterministic engine function — AI must not replicate it',
  }),
  Object.freeze({
    label:   'best_fit',
    pattern: 'best fit',
    reason:  'Unqualified superlative overclaim — prohibited confidence language',
  }),
  Object.freeze({
    label:   'guaranteed_success',
    pattern: 'guaranteed success',
    reason:  'Certainty overclaim — violates confidence grounding governance',
  }),
  Object.freeze({
    label:   'perfect_career',
    pattern: 'perfect career',
    reason:  'Superlative overclaim — violates confidence language registry',
  }),
  Object.freeze({
    label:   'you_will_succeed',
    pattern: 'you will succeed',
    reason:  'Certainty claim without data support — prohibited language pattern',
  }),
  Object.freeze({
    label:   'will_definitely',
    pattern: 'will definitely',
    reason:  'Certainty claim — in prohibited language registry',
  }),
  Object.freeze({
    label:   'no_risk',
    pattern: 'no risk',
    reason:  'False certainty claim — in prohibited language registry',
  }),
]);

// ─────────────────────────────────────────────────────────────────────────────
// SEMANTIC VERSION PATTERN
// Prompts must declare a semver version in metadata or header.
// ─────────────────────────────────────────────────────────────────────────────

const SEMVER_PATTERN = /\d+\.\d+\.\d+/;

// ─────────────────────────────────────────────────────────────────────────────
// PROMPT VALIDATION RESULT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} PromptValidationResult
 * @property {boolean}  valid
 * @property {string}   promptId
 * @property {string}   promptVersion    — extracted or 'unversioned'
 * @property {string[]} missingInstructions — labels of missing required markers
 * @property {Object[]} forbiddenMatches — { label, pattern, reason } for each match
 * @property {string[]} errors          — human-readable error messages
 */

// ─────────────────────────────────────────────────────────────────────────────
// CORE PROMPT VALIDATOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate a single prompt against all governance rules.
 *
 * This is the primary validation function. It is deterministic, pure, and
 * has no side effects. Suitable for CI/CD integration.
 *
 * @param {Object} prompt
 * @param {string} prompt.id       — stable identifier in the registry
 * @param {string} prompt.version  — semver string (e.g. '1.0.0')
 * @param {string} prompt.text     — the raw prompt text to validate
 *
 * @returns {PromptValidationResult}
 */
function validatePrompt({ id, version, text }) {
  const errors             = [];
  const missingInstructions = [];
  const forbiddenMatches   = [];

  const promptId      = String(id      ?? 'unknown');
  const promptVersion = String(version ?? 'unversioned');
  const promptText    = String(text    ?? '');

  // ── Guard: empty prompt ───────────────────────────────────────────────────
  if (!promptText.trim()) {
    return {
      valid:                false,
      promptId,
      promptVersion,
      missingInstructions:  REQUIRED_GOVERNANCE_MARKERS.map((m) => m.label),
      forbiddenMatches:     [],
      errors:               ['prompt text is empty'],
    };
  }

  const lower = promptText.toLowerCase();

  // ── Check 1: Version enforcement ──────────────────────────────────────────
  if (!SEMVER_PATTERN.test(promptVersion)) {
    errors.push(`prompt "${promptId}" has invalid version "${promptVersion}" — must be semver (e.g. 1.0.0)`);
  }

  // ── Check 2: Required governance instruction presence ─────────────────────
  for (const marker of REQUIRED_GOVERNANCE_MARKERS) {
    const found = marker.patterns.some((p) => lower.includes(p.toLowerCase()));
    if (!found) {
      missingInstructions.push(marker.label);
      errors.push(`prompt "${promptId}" is missing required governance instruction: ${marker.label} — ${marker.description}`);
    }
  }

  // ── Check 3: Forbidden pattern detection ──────────────────────────────────
  for (const forbidden of FORBIDDEN_PROMPT_PATTERNS) {
    if (lower.includes(forbidden.pattern.toLowerCase())) {
      forbiddenMatches.push(Object.freeze({
        label:   forbidden.label,
        pattern: forbidden.pattern,
        reason:  forbidden.reason,
      }));
      errors.push(`prompt "${promptId}" contains forbidden pattern "${forbidden.pattern}" — ${forbidden.reason}`);
    }
  }

  return Object.freeze({
    valid:                errors.length === 0,
    promptId,
    promptVersion,
    missingInstructions:  Object.freeze(missingInstructions),
    forbiddenMatches:     Object.freeze(forbiddenMatches),
    errors:               Object.freeze(errors),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// REGISTRY INTEGRITY VALIDATOR
// Validates a collection of prompts as a registry (checks for duplicates, etc.)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate an entire prompt registry for structural integrity.
 *
 * @param {Object[]} prompts  — array of { id, version, text } prompt objects
 * @returns {RegistryValidationResult}
 *
 * @typedef {Object} RegistryValidationResult
 * @property {boolean}  valid
 * @property {number}   totalPrompts
 * @property {number}   validPrompts
 * @property {number}   invalidPrompts
 * @property {string[]} duplicateIds       — IDs that appear more than once
 * @property {PromptValidationResult[]} promptResults
 * @property {string[]} errors
 */
function validateRegistry(prompts) {
  if (!Array.isArray(prompts)) {
    return Object.freeze({
      valid:          false,
      totalPrompts:   0,
      validPrompts:   0,
      invalidPrompts: 0,
      duplicateIds:   Object.freeze([]),
      promptResults:  Object.freeze([]),
      errors:         Object.freeze(['prompts must be an array']),
    });
  }

  const errors       = [];
  const idCounts     = new Map();
  const promptResults = [];

  // Count IDs for duplicate detection
  for (const prompt of prompts) {
    const id = String(prompt?.id ?? 'unknown');
    idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  }

  const duplicateIds = [...idCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id);

  if (duplicateIds.length > 0) {
    errors.push(`registry contains duplicate prompt IDs: ${duplicateIds.join(', ')}`);
  }

  // Validate each prompt
  for (const prompt of prompts) {
    const result = validatePrompt(prompt ?? {});
    promptResults.push(result);
    if (!result.valid) {
      errors.push(...result.errors);
    }
  }

  const validCount   = promptResults.filter((r) => r.valid).length;
  const invalidCount = promptResults.filter((r) => !r.valid).length;

  return Object.freeze({
    valid:          errors.length === 0 && duplicateIds.length === 0,
    totalPrompts:   prompts.length,
    validPrompts:   validCount,
    invalidPrompts: invalidCount,
    duplicateIds:   Object.freeze(duplicateIds),
    promptResults:  Object.freeze(promptResults),
    errors:         Object.freeze(errors),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

module.exports = Object.freeze({
  REQUIRED_GOVERNANCE_MARKERS,
  FORBIDDEN_PROMPT_PATTERNS,
  validatePrompt,
  validateRegistry,
});
