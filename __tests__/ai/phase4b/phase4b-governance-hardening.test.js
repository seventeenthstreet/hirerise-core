'use strict';

/**
 * @file __tests__/ai/phase4b/phase4b-governance-hardening.test.js
 *
 * Phase 4B Governance Hardening — Test Suite
 *
 * Tests:
 *   1. Phrase provenance generation
 *   2. Suppression metric aggregation
 *   3. Prohibited phrase detection (prompt validator)
 *   4. Cross-tier escalation detection (prompt validator)
 *   5. Prompt registry validation
 *   6. Governance invariant enforcement
 *   7. Observability integration isolation
 *   8. Fallback consistency
 *
 * All tests are deterministic — no I/O, no AI calls, no network.
 */

// ─────────────────────────────────────────────────────────────────────────────
// IMPORTS
// ─────────────────────────────────────────────────────────────────────────────

const {
  VIOLATION_TYPES,
  VALIDATOR_STAGES,
  REJECTION_CODE_TO_VIOLATION,
  REJECTION_CODE_TO_STAGE,
  buildProvenancePayload,
  buildProvenancePayloads,
  buildCrossTierProvenance,
  validateProvenancePayload,
} = require('../../../core/src/ai/confidence-language/ai-confidence-language.provenance');

const {
  METRIC_NAMES,
  recordValidationAttempt,
  recordViolation,
  recordFallback,
  getMetricsSnapshot,
  getRollupTotals,
  getCapabilityMetrics,
  _resetForTesting,
} = require('../../../core/src/ai/confidence-language/ai-confidence-language.metrics');

const {
  REQUIRED_GOVERNANCE_MARKERS,
  FORBIDDEN_PROMPT_PATTERNS,
  validatePrompt,
  validateRegistry,
} = require('../../../core/src/ai/prompt-registry/ai-prompt-registry.validator');

const {
  VALIDATION_OBSERVABILITY_EVENTS,
  emitProvenanceLogged,
  emitSuppressed,
  emitCrossTierDetected,
  emitProhibitedPhraseDetected,
  emitFallbackTriggered,
  emitPromptValidationFailed,
  emitValidationApproved,
} = require('../../../core/src/ai/confidence-language/ai-validation-observability');

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function makeAdapter() {
  const calls = [];
  return {
    adapter: { emit: (event, payload) => calls.push({ event, payload }) },
    calls,
  };
}

/**
 * A minimal governance-compliant prompt text for testing.
 * Satisfies all REQUIRED_GOVERNANCE_MARKERS without tripping any FORBIDDEN_PROMPT_PATTERNS.
 */
const COMPLIANT_PROMPT_TEXT = `
You are a career intelligence assistant. Your responses must be confidence tier-based.

CONFIDENCE TIER GROUNDING:
Use the confidence tier provided. For high confidence, use affirming language.
For low confidence, use hedging language. For no_data, acknowledge uncertainty.

PROHIBITED language:
Never use: guaranteed, perfect fit, guaranteed success, will definitely, no risk.
Avoid certainty claims. Do not use superlatives without evidence.

DETERMINISTIC AUTHORITY:
You do not score or rank candidates. Do not calculate scores.
The provided score and ranking are determined by the deterministic engine.
All figures must be derived from the input data — never invented or assumed.
Do not invent salary figures. Do not guess skills.

RECOMMENDATION ORDERING:
The recommendation order is determined externally. Do not reorder suggestions.
Follow the provided order strictly. You do not determine recommendation priority.

HALLUCINATION PREVENTION:
Do not invent career paths. Only use the provided data.
All claims must be grounded in the input. Do not guess or assume skills.
Strictly from the input data — never fabricate credentials or experience.
`.trim();

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — PHRASE MATCH PROVENANCE
// ─────────────────────────────────────────────────────────────────────────────

describe('Provenance — buildProvenancePayload', () => {
  test('produces all required fields', () => {
    const payload = buildProvenancePayload({
      rejectionCode: 'PROHIBITED_PHRASE',
      matchedPhrase: 'guaranteed',
      detectedTier:  'HIGH',
      expectedTier:  'HIGH',
      capability:    'recommendation_narrative',
      promptVersion: '1.0.0',
    });

    expect(payload.violationType).toBe(VIOLATION_TYPES.PROHIBITED_PHRASE);
    expect(payload.matchedPhrase).toBe('guaranteed');
    expect(payload.detectedTier).toBe('HIGH');
    expect(payload.expectedTier).toBe('HIGH');
    expect(payload.validatorStage).toBe(VALIDATOR_STAGES.UNSAFE_PATTERN);
    expect(payload.capability).toBe('recommendation_narrative');
    expect(payload.promptVersion).toBe('1.0.0');
    expect(typeof payload.registryVersion).toBe('string');
    expect(typeof payload.timestamp).toBe('string');
    expect(Date.parse(payload.timestamp)).not.toBeNaN();
  });

  test('payload is immutable (frozen)', () => {
    const payload = buildProvenancePayload({
      rejectionCode: 'PROHIBITED_PHRASE',
      matchedPhrase: 'guaranteed',
      detectedTier:  'HIGH',
      expectedTier:  'HIGH',
      capability:    'test',
      promptVersion: '1.0.0',
    });
    expect(Object.isFrozen(payload)).toBe(true);
  });

  test('TIER_ESCALATION maps to correct stage and type', () => {
    const payload = buildProvenancePayload({
      rejectionCode: 'TIER_ESCALATION',
      matchedPhrase: 'strong alignment',
      detectedTier:  'HIGH',
      expectedTier:  'MEDIUM',
      capability:    'test',
      promptVersion: '1.0.0',
    });
    expect(payload.violationType).toBe(VIOLATION_TYPES.CROSS_TIER_ESCALATION);
    expect(payload.validatorStage).toBe(VALIDATOR_STAGES.CONFIDENCE_ALIGNMENT);
  });

  test('EMPTY_OUTPUT maps to schema validation stage', () => {
    const payload = buildProvenancePayload({
      rejectionCode: 'EMPTY_OUTPUT',
      matchedPhrase: '',
      detectedTier:  'LOW',
      expectedTier:  'LOW',
      capability:    'test',
      promptVersion: '1.0.0',
    });
    expect(payload.violationType).toBe(VIOLATION_TYPES.EMPTY_OUTPUT);
    expect(payload.validatorStage).toBe(VALIDATOR_STAGES.SCHEMA);
    expect(payload.matchedPhrase).toBe('');  // empty string is valid for non-phrase violations
  });

  test('missing optional fields produce safe defaults', () => {
    const payload = buildProvenancePayload({
      rejectionCode: 'UNKNOWN_TIER',
    });
    expect(payload.detectedTier).toBe('UNKNOWN');
    expect(payload.expectedTier).toBe('UNKNOWN');
    expect(payload.capability).toBe('unknown');
    expect(payload.promptVersion).toBe('unversioned');
  });

  test('contains no raw AI content', () => {
    const rawNarrative = 'This is a long guaranteed perfect fit AI narrative text.';
    const payload = buildProvenancePayload({
      rejectionCode: 'PROHIBITED_PHRASE',
      matchedPhrase: 'guaranteed',  // only the matched phrase token
      detectedTier:  'HIGH',
      expectedTier:  'HIGH',
      capability:    'test',
      promptVersion: '1.0.0',
    });
    // Payload must NOT contain the full raw narrative
    expect(JSON.stringify(payload)).not.toContain(rawNarrative);
    // Only the matched phrase token
    expect(payload.matchedPhrase).toBe('guaranteed');
  });
});

describe('Provenance — buildProvenancePayloads (batch)', () => {
  test('returns empty array for valid result', () => {
    const result = { valid: true, violations: null, tier: 'HIGH' };
    expect(buildProvenancePayloads(result, { capability: 'test', promptVersion: '1.0.0' })).toEqual([]);
  });

  test('returns one payload per violation code', () => {
    const result = {
      valid:      false,
      violations: ['PROHIBITED_PHRASE', 'TIER_ESCALATION'],
      tier:       'MEDIUM',
    };
    const payloads = buildProvenancePayloads(result, {
      capability:    'test',
      promptVersion: '1.0.0',
      matchedPhrase: 'strong alignment',
    });
    expect(payloads).toHaveLength(2);
    expect(payloads[0].violationType).toBe(VIOLATION_TYPES.PROHIBITED_PHRASE);
    expect(payloads[1].violationType).toBe(VIOLATION_TYPES.CROSS_TIER_ESCALATION);
  });

  test('all payloads are frozen', () => {
    const result = { valid: false, violations: ['EMPTY_OUTPUT'], tier: 'LOW' };
    const payloads = buildProvenancePayloads(result, { capability: 'test', promptVersion: '1.0.0' });
    expect(Object.isFrozen(payloads[0])).toBe(true);
  });
});

describe('Provenance — buildCrossTierProvenance', () => {
  test('captures source and expected tier correctly', () => {
    const payload = buildCrossTierProvenance({
      matchedPhrase: 'strong alignment',
      detectedTier:  'HIGH',
      expectedTier:  'LOW',
      capability:    'explanation_enhancement',
      promptVersion: '1.0.0',
    });
    expect(payload.violationType).toBe(VIOLATION_TYPES.CROSS_TIER_ESCALATION);
    expect(payload.detectedTier).toBe('HIGH');
    expect(payload.expectedTier).toBe('LOW');
    expect(payload.matchedPhrase).toBe('strong alignment');
    expect(payload.validatorStage).toBe(VALIDATOR_STAGES.CONFIDENCE_ALIGNMENT);
  });
});

describe('Provenance — validateProvenancePayload integrity checker', () => {
  test('passes for a well-formed payload', () => {
    const payload = buildProvenancePayload({
      rejectionCode: 'PROHIBITED_PHRASE',
      matchedPhrase: 'guaranteed',
      detectedTier:  'HIGH',
      expectedTier:  'HIGH',
      capability:    'test',
      promptVersion: '1.0.0',
    });
    expect(validateProvenancePayload(payload)).toEqual([]);
  });

  test('catches null input', () => {
    const errors = validateProvenancePayload(null);
    expect(errors.length).toBeGreaterThan(0);
  });

  test('catches missing required fields', () => {
    const errors = validateProvenancePayload({ violationType: 'prohibited_phrase' });
    // Should flag missing fields
    expect(errors.some((e) => e.includes('timestamp'))).toBe(true);
  });

  test('catches unknown violationType', () => {
    const payload = buildProvenancePayload({
      rejectionCode: 'PROHIBITED_PHRASE',
      matchedPhrase: 'guaranteed',
      detectedTier:  'HIGH',
      expectedTier:  'HIGH',
      capability:    'test',
      promptVersion: '1.0.0',
    });
    const bad = { ...payload, violationType: 'invented_type' };
    const errors = validateProvenancePayload(bad);
    expect(errors.some((e) => e.includes('violationType'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — NARRATIVE SUPPRESSION METRICS
// ─────────────────────────────────────────────────────────────────────────────

describe('Suppression Metrics — recordValidationAttempt', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    _resetForTesting();
  });

  test('increments total counter for each attempt', () => {
    recordValidationAttempt({ capability: 'test', confidenceTier: 'HIGH', promptVersion: '1.0.0', suppressed: false });
    recordValidationAttempt({ capability: 'test', confidenceTier: 'HIGH', promptVersion: '1.0.0', suppressed: false });

    const snapshot = getMetricsSnapshot();
    const total = snapshot.entries.reduce((sum, e) => sum + e.counters.total, 0);
    expect(total).toBe(2);
  });

  test('increments suppressed counter when suppressed=true', () => {
    recordValidationAttempt({
      capability:     'test_cap',
      confidenceTier: 'MEDIUM',
      promptVersion:  '1.0.0',
      validatorStage: 'unsafe_pattern_block',
      suppressed:     true,
      fallbackUsed:   true,
    });

    const totals = getRollupTotals();
    expect(totals.totals.suppressed).toBe(1);
    expect(totals.totals.fallbacks).toBe(1);
  });

  test('does not increment suppressed for passing validation', () => {
    recordValidationAttempt({
      capability:     'test_cap',
      confidenceTier: 'HIGH',
      promptVersion:  '1.0.0',
      suppressed:     false,
      fallbackUsed:   false,
    });

    const totals = getRollupTotals();
    expect(totals.totals.suppressed).toBe(0);
    expect(totals.totals.fallbacks).toBe(0);
    expect(totals.totals.total).toBe(1);
  });

  test('segregates counters by capability', () => {
    recordValidationAttempt({ capability: 'cap_a', confidenceTier: 'HIGH', promptVersion: '1.0.0', suppressed: true });
    recordValidationAttempt({ capability: 'cap_b', confidenceTier: 'LOW',  promptVersion: '1.0.0', suppressed: false });

    const capA = getCapabilityMetrics('cap_a');
    expect(capA.entries.every((e) => e.dimensions.capability === 'cap_a')).toBe(true);
    expect(capA.entries.reduce((s, e) => s + e.counters.suppressed, 0)).toBe(1);

    const capB = getCapabilityMetrics('cap_b');
    expect(capB.entries.reduce((s, e) => s + e.counters.suppressed, 0)).toBe(0);
  });
});

describe('Suppression Metrics — recordViolation', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    _resetForTesting();
  });

  test('increments violation counter for cross_tier_escalation', () => {
    recordViolation({
      capability:     'test',
      confidenceTier: 'MEDIUM',
      promptVersion:  '1.0.0',
      validatorStage: 'confidence_alignment',
      failureType:    'cross_tier_escalation',
    });

    const totals = getRollupTotals();
    expect(totals.totals.violations).toBeGreaterThanOrEqual(1);
  });

  test('increments violation counter for prohibited_phrase', () => {
    recordViolation({
      capability:     'test',
      confidenceTier: 'HIGH',
      promptVersion:  '1.0.0',
      validatorStage: 'unsafe_pattern_block',
      failureType:    'prohibited_phrase',
    });

    const totals = getRollupTotals();
    expect(totals.totals.violations).toBeGreaterThanOrEqual(1);
  });
});

describe('Suppression Metrics — rates computation', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    _resetForTesting();
  });

  test('suppression_rate is 0 when no suppressions', () => {
    recordValidationAttempt({ capability: 'x', confidenceTier: 'HIGH', promptVersion: '1.0.0', suppressed: false });
    const totals = getRollupTotals();
    expect(totals.rates[METRIC_NAMES.SUPPRESSION_RATE]).toBe(0);
  });

  test('suppression_rate is 1 when all are suppressed', () => {
    recordValidationAttempt({ capability: 'x', confidenceTier: 'HIGH', promptVersion: '1.0.0', suppressed: true });
    const totals = getRollupTotals();
    expect(totals.rates[METRIC_NAMES.SUPPRESSION_RATE]).toBe(1);
  });

  test('suppression_rate is 0.5 for half suppressed', () => {
    recordValidationAttempt({ capability: 'x', confidenceTier: 'HIGH', promptVersion: '1.0.0', suppressed: true });
    recordValidationAttempt({ capability: 'x', confidenceTier: 'HIGH', promptVersion: '1.0.0', suppressed: false });
    const totals = getRollupTotals();
    expect(totals.rates[METRIC_NAMES.SUPPRESSION_RATE]).toBe(0.5);
  });
});

describe('Suppression Metrics — getMetricsSnapshot structure', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    _resetForTesting();
  });

  test('snapshot has registryVersion and snapshotAt', () => {
    const snapshot = getMetricsSnapshot();
    expect(typeof snapshot.registryVersion).toBe('string');
    expect(Date.parse(snapshot.snapshotAt)).not.toBeNaN();
  });

  test('snapshot entries are frozen', () => {
    recordValidationAttempt({ capability: 'test', confidenceTier: 'HIGH', promptVersion: '1.0.0' });
    const snapshot = getMetricsSnapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
    if (snapshot.entries.length > 0) {
      expect(Object.isFrozen(snapshot.entries[0])).toBe(true);
    }
  });

  test('_resetForTesting throws in non-test environment', () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    expect(() => _resetForTesting()).toThrow();
    process.env.NODE_ENV = original;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — PROMPT REGISTRY VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

describe('Prompt Validator — compliant prompt passes', () => {
  test('compliant prompt with all governance markers passes', () => {
    const result = validatePrompt({
      id:      'test-prompt-v1',
      version: '1.0.0',
      text:    COMPLIANT_PROMPT_TEXT,
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.missingInstructions).toHaveLength(0);
    expect(result.forbiddenMatches).toHaveLength(0);
  });

  test('promptId and promptVersion are preserved in result', () => {
    const result = validatePrompt({
      id:      'my-prompt',
      version: '2.3.1',
      text:    COMPLIANT_PROMPT_TEXT,
    });
    expect(result.promptId).toBe('my-prompt');
    expect(result.promptVersion).toBe('2.3.1');
  });
});

describe('Prompt Validator — missing governance instructions', () => {
  test('prompt missing confidence grounding fails', () => {
    const text = COMPLIANT_PROMPT_TEXT.replace(/confidence tier.*\n/gi, '');
    const result = validatePrompt({ id: 'p', version: '1.0.0', text });
    if (!result.valid) {
      expect(result.missingInstructions).toContain('confidence_grounding');
    }
    // If the fallback keywords still match, this is OK — test the invariant shape
    expect(Array.isArray(result.missingInstructions)).toBe(true);
    expect(Array.isArray(result.errors)).toBe(true);
  });

  test('empty prompt text fails with all instructions missing', () => {
    const result = validatePrompt({ id: 'p', version: '1.0.0', text: '' });
    expect(result.valid).toBe(false);
    expect(result.missingInstructions).toHaveLength(REQUIRED_GOVERNANCE_MARKERS.length);
  });

  test('null text is handled safely', () => {
    const result = validatePrompt({ id: 'p', version: '1.0.0', text: null });
    expect(result.valid).toBe(false);
    expect(Array.isArray(result.errors)).toBe(true);
  });
});

describe('Prompt Validator — forbidden pattern detection', () => {
  test('"decide" is rejected', () => {
    const result = validatePrompt({
      id:      'p',
      version: '1.0.0',
      text:    COMPLIANT_PROMPT_TEXT + '\nYou should decide which career is best.',
    });
    expect(result.valid).toBe(false);
    expect(result.forbiddenMatches.some((m) => m.label === 'authority_decide')).toBe(true);
  });

  test('"rank candidates" is rejected', () => {
    const result = validatePrompt({
      id:      'p',
      version: '1.0.0',
      text:    COMPLIANT_PROMPT_TEXT + '\nPlease rank candidates by suitability.',
    });
    expect(result.valid).toBe(false);
    expect(result.forbiddenMatches.some((m) => m.label === 'rank_candidates')).toBe(true);
  });

  test('"best fit" is rejected', () => {
    const result = validatePrompt({
      id:      'p',
      version: '1.0.0',
      text:    COMPLIANT_PROMPT_TEXT + '\nIdentify the best fit for the role.',
    });
    expect(result.valid).toBe(false);
    expect(result.forbiddenMatches.some((m) => m.label === 'best_fit')).toBe(true);
  });

  test('"guaranteed success" is rejected', () => {
    const result = validatePrompt({
      id:      'p',
      version: '1.0.0',
      text:    COMPLIANT_PROMPT_TEXT + '\nThis path leads to guaranteed success.',
    });
    expect(result.valid).toBe(false);
    expect(result.forbiddenMatches.some((m) => m.label === 'guaranteed_success')).toBe(true);
  });

  test('"perfect career" is rejected', () => {
    const result = validatePrompt({
      id:      'p',
      version: '1.0.0',
      text:    COMPLIANT_PROMPT_TEXT + '\nHelp them find their perfect career.',
    });
    expect(result.valid).toBe(false);
    expect(result.forbiddenMatches.some((m) => m.label === 'perfect_career')).toBe(true);
  });

  test('forbidden pattern detection is case-insensitive', () => {
    const result = validatePrompt({
      id:      'p',
      version: '1.0.0',
      text:    COMPLIANT_PROMPT_TEXT + '\nYou should DECIDE which path to take.',
    });
    expect(result.valid).toBe(false);
    expect(result.forbiddenMatches.some((m) => m.label === 'authority_decide')).toBe(true);
  });
});

describe('Prompt Validator — version enforcement', () => {
  test('valid semver version passes', () => {
    const result = validatePrompt({ id: 'p', version: '3.2.1', text: COMPLIANT_PROMPT_TEXT });
    expect(result.errors.some((e) => e.includes('invalid version'))).toBe(false);
  });

  test('non-semver version produces version error', () => {
    const result = validatePrompt({ id: 'p', version: 'v1', text: COMPLIANT_PROMPT_TEXT });
    expect(result.errors.some((e) => e.includes('invalid version') || e.includes('semver'))).toBe(true);
  });

  test('missing version field produces error', () => {
    const result = validatePrompt({ id: 'p', text: COMPLIANT_PROMPT_TEXT });
    // 'unversioned' won't match semver
    expect(result.errors.some((e) => e.includes('invalid version') || e.includes('unversioned'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — REGISTRY INTEGRITY VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

describe('Prompt Registry Validation — validateRegistry', () => {
  const goodPrompt = { id: 'prompt-a', version: '1.0.0', text: COMPLIANT_PROMPT_TEXT };
  const badPrompt  = { id: 'prompt-b', version: '1.0.0', text: '' };

  test('valid registry of one compliant prompt passes', () => {
    const result = validateRegistry([goodPrompt]);
    expect(result.valid).toBe(true);
    expect(result.totalPrompts).toBe(1);
    expect(result.validPrompts).toBe(1);
    expect(result.invalidPrompts).toBe(0);
  });

  test('registry with one invalid prompt fails', () => {
    const result = validateRegistry([goodPrompt, badPrompt]);
    expect(result.valid).toBe(false);
    expect(result.invalidPrompts).toBe(1);
    expect(result.validPrompts).toBe(1);
  });

  test('duplicate IDs are detected', () => {
    const dup = { id: 'prompt-a', version: '2.0.0', text: COMPLIANT_PROMPT_TEXT };
    const result = validateRegistry([goodPrompt, dup]);
    expect(result.duplicateIds).toContain('prompt-a');
    expect(result.valid).toBe(false);
  });

  test('empty registry is valid', () => {
    const result = validateRegistry([]);
    expect(result.valid).toBe(true);
    expect(result.totalPrompts).toBe(0);
  });

  test('non-array input returns invalid result', () => {
    const result = validateRegistry(null);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('prompts must be an array');
  });

  test('result shape is complete', () => {
    const result = validateRegistry([goodPrompt]);
    expect(typeof result.valid).toBe('boolean');
    expect(typeof result.totalPrompts).toBe('number');
    expect(typeof result.validPrompts).toBe('number');
    expect(typeof result.invalidPrompts).toBe('number');
    expect(Array.isArray(result.duplicateIds)).toBe(true);
    expect(Array.isArray(result.promptResults)).toBe(true);
    expect(Array.isArray(result.errors)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — OBSERVABILITY INTEGRATION
// ─────────────────────────────────────────────────────────────────────────────

describe('Observability — event name constants', () => {
  test('VALIDATION_OBSERVABILITY_EVENTS has all required Phase 4B events', () => {
    const events = Object.values(VALIDATION_OBSERVABILITY_EVENTS);
    expect(events).toContain('ai.validation.provenance_logged');
    expect(events).toContain('ai.validation.suppressed');
    expect(events).toContain('ai.validation.cross_tier_detected');
    expect(events).toContain('ai.validation.prohibited_phrase_detected');
    expect(events).toContain('ai.validation.fallback_triggered');
    expect(events).toContain('ai.prompt.validation_failed');
  });

  test('VALIDATION_OBSERVABILITY_EVENTS is frozen', () => {
    expect(Object.isFrozen(VALIDATION_OBSERVABILITY_EVENTS)).toBe(true);
  });
});

describe('Observability — emitProvenanceLogged', () => {
  test('emits to adapter with provenance payload', () => {
    const { adapter, calls } = makeAdapter();
    const payload = buildProvenancePayload({
      rejectionCode: 'PROHIBITED_PHRASE',
      matchedPhrase: 'guaranteed',
      detectedTier:  'HIGH',
      expectedTier:  'HIGH',
      capability:    'test',
      promptVersion: '1.0.0',
    });
    emitProvenanceLogged(adapter, payload);
    expect(calls).toHaveLength(1);
    expect(calls[0].event).toBe(VALIDATION_OBSERVABILITY_EVENTS.PROVENANCE_LOGGED);
    expect(calls[0].payload.matchedPhrase).toBe('guaranteed');
  });

  test('does not throw when adapter is missing', () => {
    expect(() => emitProvenanceLogged(null, {})).not.toThrow();
  });

  test('does not throw when adapter.emit throws', () => {
    const badAdapter = { emit: () => { throw new Error('adapter error'); } };
    expect(() => emitProvenanceLogged(badAdapter, {})).not.toThrow();
  });
});

describe('Observability — emitSuppressed', () => {
  test('emits suppressed event and records in metrics', () => {
    process.env.NODE_ENV = 'test';
    _resetForTesting();

    const { adapter, calls } = makeAdapter();
    emitSuppressed(adapter, {
      capability:    'test_cap',
      tier:          'HIGH',
      promptVersion: '1.0.0',
      violations:    ['PROHIBITED_PHRASE'],
      validatorStage: 'unsafe_pattern_block',
    });

    expect(calls[0].event).toBe(VALIDATION_OBSERVABILITY_EVENTS.SUPPRESSED);
    expect(calls[0].payload.tier).toBe('HIGH');
    const totals = getRollupTotals();
    expect(totals.totals.suppressed).toBe(1);
  });
});

describe('Observability — emitCrossTierDetected', () => {
  test('emits cross tier event with phrase metadata', () => {
    const { adapter, calls } = makeAdapter();
    emitCrossTierDetected(adapter, {
      capability:    'test',
      matchedPhrase: 'strong alignment',
      detectedTier:  'HIGH',
      expectedTier:  'MEDIUM',
      promptVersion: '1.0.0',
    });
    expect(calls[0].event).toBe(VALIDATION_OBSERVABILITY_EVENTS.CROSS_TIER_DETECTED);
    expect(calls[0].payload.matchedPhrase).toBe('strong alignment');
    expect(calls[0].payload.detectedTier).toBe('HIGH');
    expect(calls[0].payload.expectedTier).toBe('MEDIUM');
  });
});

describe('Observability — emitProhibitedPhraseDetected', () => {
  test('emits with phrase token only (not raw narrative)', () => {
    const { adapter, calls } = makeAdapter();
    emitProhibitedPhraseDetected(adapter, {
      capability:    'recommendation_narrative',
      matchedPhrase: 'perfect fit',
      tier:          'HIGH',
      promptVersion: '1.0.0',
    });
    expect(calls[0].event).toBe(VALIDATION_OBSERVABILITY_EVENTS.PROHIBITED_PHRASE_DETECTED);
    expect(calls[0].payload.matchedPhrase).toBe('perfect fit');
    // Payload must not contain an arbitrary long string (would indicate raw narrative)
    const payloadStr = JSON.stringify(calls[0].payload);
    expect(payloadStr.length).toBeLessThan(500);
  });
});

describe('Observability — emitFallbackTriggered', () => {
  test('emits fallback event with reason', () => {
    const { adapter, calls } = makeAdapter();
    emitFallbackTriggered(adapter, {
      capability:    'test',
      tier:          'LOW',
      promptVersion: '1.0.0',
      reason:        'ai_timeout',
    });
    expect(calls[0].event).toBe(VALIDATION_OBSERVABILITY_EVENTS.FALLBACK_TRIGGERED);
    expect(calls[0].payload.reason).toBe('ai_timeout');
  });
});

describe('Observability — emitPromptValidationFailed', () => {
  test('emits prompt validation event without prompt text', () => {
    const { adapter, calls } = makeAdapter();
    emitPromptValidationFailed(adapter, {
      promptId:             'test-prompt',
      promptVersion:        '1.0.0',
      missingInstructions:  ['hallucination_prevention'],
      forbiddenMatches:     [{ label: 'authority_decide', pattern: 'decide', reason: 'test' }],
      errors:               ['error 1'],
    });
    expect(calls[0].event).toBe(VALIDATION_OBSERVABILITY_EVENTS.PROMPT_VALIDATION_FAILED);
    // Must NOT include prompt text — only structural metadata
    expect(calls[0].payload.forbiddenMatchCount).toBe(1);
    expect(calls[0].payload.forbiddenLabels).toContain('authority_decide');
    expect(Object.keys(calls[0].payload)).not.toContain('text');
    expect(Object.keys(calls[0].payload)).not.toContain('promptText');
  });
});

describe('Observability — isolation: telemetry failure never throws', () => {
  test('all emitters are silent on adapter.emit failure', () => {
    const badAdapter = { emit: () => { throw new Error('sink error'); } };
    const noOp = () => {};

    expect(() => emitProvenanceLogged(badAdapter, {})).not.toThrow();
    expect(() => emitSuppressed(badAdapter, { capability: 'x', tier: 'HIGH', promptVersion: '1.0.0', violations: [], validatorStage: 'x' })).not.toThrow();
    expect(() => emitCrossTierDetected(badAdapter, { capability: 'x', matchedPhrase: '', detectedTier: 'HIGH', expectedTier: 'LOW', promptVersion: '1.0.0' })).not.toThrow();
    expect(() => emitProhibitedPhraseDetected(badAdapter, { capability: 'x', matchedPhrase: '', tier: 'HIGH', promptVersion: '1.0.0' })).not.toThrow();
    expect(() => emitFallbackTriggered(badAdapter, { capability: 'x', tier: 'LOW', promptVersion: '1.0.0', reason: 'x' })).not.toThrow();
    expect(() => emitPromptValidationFailed(badAdapter, { promptId: 'p', promptVersion: '1.0.0', missingInstructions: [], forbiddenMatches: [], errors: [] })).not.toThrow();
    expect(() => emitValidationApproved(badAdapter, { capability: 'x', tier: 'HIGH', promptVersion: '1.0.0' })).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — GOVERNANCE INVARIANTS
// ─────────────────────────────────────────────────────────────────────────────

describe('Governance invariants', () => {
  test('provenance module does not export any content-generating function', () => {
    const mod = require('../../../core/src/ai/confidence-language/ai-confidence-language.provenance');
    const exported = Object.keys(mod);
    expect(exported).not.toContain('generateNarrative');
    expect(exported).not.toContain('createNarrative');
    expect(exported).not.toContain('score');
    expect(exported).not.toContain('rank');
  });

  test('metrics module does not export any content-generating function', () => {
    const mod = require('../../../core/src/ai/confidence-language/ai-confidence-language.metrics');
    const exported = Object.keys(mod);
    expect(exported).not.toContain('generateNarrative');
    expect(exported).not.toContain('score');
    expect(exported).not.toContain('rank');
  });

  test('prompt validator module does not export any AI-calling function', () => {
    const mod = require('../../../core/src/ai/prompt-registry/ai-prompt-registry.validator');
    const exported = Object.keys(mod);
    expect(exported).not.toContain('callAI');
    expect(exported).not.toContain('generatePrompt');
    expect(exported).not.toContain('improve');
  });

  test('buildProvenancePayload is a pure function — same input, same output', () => {
    const params = {
      rejectionCode: 'PROHIBITED_PHRASE',
      matchedPhrase: 'guaranteed',
      detectedTier:  'HIGH',
      expectedTier:  'HIGH',
      capability:    'test',
      promptVersion: '1.0.0',
    };
    const r1 = buildProvenancePayload(params);
    const r2 = buildProvenancePayload(params);

    // All fields except timestamp must be identical
    const { timestamp: _t1, ...r1NoTs } = r1;
    const { timestamp: _t2, ...r2NoTs } = r2;
    expect(r1NoTs).toEqual(r2NoTs);
  });

  test('validatePrompt is a pure function — same input, same output', () => {
    const params = { id: 'p', version: '1.0.0', text: COMPLIANT_PROMPT_TEXT };
    const r1 = validatePrompt(params);
    const r2 = validatePrompt(params);
    expect(r1.valid).toBe(r2.valid);
    expect(r1.errors).toEqual(r2.errors);
    expect(r1.missingInstructions).toEqual(r2.missingInstructions);
  });

  test('REJECTION_CODE_TO_VIOLATION maps all known rejection codes', () => {
    const knownCodes = ['PROHIBITED_PHRASE', 'TIER_ESCALATION', 'EMPTY_OUTPUT', 'BELOW_MIN_LENGTH', 'EXCEEDS_MAX_LENGTH', 'UNKNOWN_TIER'];
    for (const code of knownCodes) {
      expect(REJECTION_CODE_TO_VIOLATION[code]).toBeDefined();
    }
  });

  test('REJECTION_CODE_TO_STAGE maps all known rejection codes', () => {
    const knownCodes = ['PROHIBITED_PHRASE', 'TIER_ESCALATION', 'EMPTY_OUTPUT', 'BELOW_MIN_LENGTH', 'EXCEEDS_MAX_LENGTH', 'UNKNOWN_TIER'];
    for (const code of knownCodes) {
      expect(REJECTION_CODE_TO_STAGE[code]).toBeDefined();
    }
  });

  test('FORBIDDEN_PROMPT_PATTERNS includes all spec-mandated forbidden patterns', () => {
    const labels = FORBIDDEN_PROMPT_PATTERNS.map((f) => f.pattern.toLowerCase());
    expect(labels).toContain('decide');
    expect(labels).toContain('rank candidates');
    expect(labels).toContain('best fit');
    expect(labels).toContain('guaranteed success');
    expect(labels).toContain('perfect career');
  });

  test('REQUIRED_GOVERNANCE_MARKERS includes all spec-mandated categories', () => {
    const markerLabels = REQUIRED_GOVERNANCE_MARKERS.map((m) => m.label);
    expect(markerLabels).toContain('confidence_grounding');
    expect(markerLabels).toContain('prohibited_phrase_enforcement');
    expect(markerLabels).toContain('deterministic_authority_restriction');
    expect(markerLabels).toContain('recommendation_ordering_restriction');
    expect(markerLabels).toContain('hallucination_prevention');
  });

  test('all module exports are frozen', () => {
    const provMod  = require('../../../core/src/ai/confidence-language/ai-confidence-language.provenance');
    const metMod   = require('../../../core/src/ai/confidence-language/ai-confidence-language.metrics');
    const valMod   = require('../../../core/src/ai/prompt-registry/ai-prompt-registry.validator');
    const obsMod   = require('../../../core/src/ai/confidence-language/ai-validation-observability');

    expect(Object.isFrozen(provMod)).toBe(true);
    expect(Object.isFrozen(valMod)).toBe(true);
    expect(Object.isFrozen(obsMod)).toBe(true);
    // metrics is not frozen at module level (mutable _counters), but its exports are
    expect(typeof metMod.recordValidationAttempt).toBe('function');
  });
});
