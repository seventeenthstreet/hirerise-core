'use strict';

/**
 * @file __tests__/ai/confidence-language.test.js
 *
 * AI Confidence Language Registry & Validator — Test Suite
 *
 * Tests the deterministic governance layer only. No AI calls, no I/O.
 */

const {
  CONFIDENCE_TIERS,
  VOCABULARY,
  REGISTRY_VERSION,
  getPromptGroundingInstructions,
  validateNarrative,
  validateBatch,
  REJECTION_CODES,
  VALIDATION_CONFIG,
  createConfidenceLanguageService,
  TELEMETRY_EVENTS,
} = require('../../core/src/ai/confidence-language/index');

// ─────────────────────────────────────────────────────────────────────────────
// REGISTRY INTEGRITY
// ─────────────────────────────────────────────────────────────────────────────

describe('Registry — structural integrity', () => {
  test('CONFIDENCE_TIERS defines all four tiers', () => {
    expect(Object.keys(CONFIDENCE_TIERS)).toEqual(
      expect.arrayContaining(['HIGH', 'MEDIUM', 'LOW', 'NO_DATA'])
    );
  });

  test('REGISTRY_VERSION has version, createdAt, owner', () => {
    expect(REGISTRY_VERSION.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(REGISTRY_VERSION.owner).toBe('hirerise-ai-governance');
  });

  test.each(Object.values(CONFIDENCE_TIERS))(
    'VOCABULARY[%s] has allowed, preferred, prohibited, fallback',
    (tier) => {
      const vocab = VOCABULARY[tier];
      expect(Array.isArray(vocab.allowed)).toBe(true);
      expect(Array.isArray(vocab.preferred)).toBe(true);
      expect(Array.isArray(vocab.prohibited)).toBe(true);
      expect(typeof vocab.fallback).toBe('string');
      expect(vocab.fallback.length).toBeGreaterThan(10);
    }
  );

  test.each(Object.values(CONFIDENCE_TIERS))(
    'preferred[%s] is a strict subset of allowed',
    (tier) => {
      const { allowed, preferred } = VOCABULARY[tier];
      const allowedSet = new Set(allowed);
      for (const phrase of preferred) {
        expect(allowedSet.has(phrase)).toBe(true);
      }
    }
  );

  test('VOCABULARY is frozen (immutable)', () => {
    expect(Object.isFrozen(VOCABULARY)).toBe(true);
    expect(Object.isFrozen(VOCABULARY.HIGH)).toBe(true);
    expect(Object.isFrozen(VOCABULARY.HIGH.allowed)).toBe(true);
  });

  test('getPromptGroundingInstructions returns string containing tier and phrases', () => {
    const instructions = getPromptGroundingInstructions('HIGH');
    expect(instructions).toContain('HIGH');
    expect(instructions).toContain('strong alignment');  // preferred phrase
    expect(instructions).toContain('guaranteed');        // prohibited phrase
  });

  test('getPromptGroundingInstructions throws on unknown tier', () => {
    expect(() => getPromptGroundingInstructions('UNKNOWN')).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATOR — valid narratives
// ─────────────────────────────────────────────────────────────────────────────

describe('Validator — valid narratives pass', () => {
  test('HIGH tier: preferred phrase passes', () => {
    const result = validateNarrative(
      'Your profile shows strong alignment with a career in software engineering.',
      'HIGH'
    );
    expect(result.valid).toBe(true);
    expect(result.violations).toBeNull();
    expect(result.tier).toBe('HIGH');
    expect(result.registryVersion).toBe(REGISTRY_VERSION.version);
  });

  test('MEDIUM tier: preferred phrase passes', () => {
    const result = validateNarrative(
      'Your profile suggests some alignment with this direction based on emerging strengths.',
      'MEDIUM'
    );
    expect(result.valid).toBe(true);
  });

  test('LOW tier: preferred phrase passes', () => {
    const result = validateNarrative(
      'Based on limited data, early signals suggest this direction may be worth exploring.',
      'LOW'
    );
    expect(result.valid).toBe(true);
  });

  test('NO_DATA tier: preferred phrase passes', () => {
    const result = validateNarrative(
      "We don't yet have enough information to assess this area. Your profile is still building.",
      'NO_DATA'
    );
    expect(result.valid).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATOR — prohibited phrases rejected
// ─────────────────────────────────────────────────────────────────────────────

describe('Validator — prohibited phrases are rejected', () => {
  test('HIGH tier: "guaranteed" is rejected', () => {
    const result = validateNarrative(
      'This is guaranteed to be the right career path for you.',
      'HIGH'
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toContain(REJECTION_CODES.PROHIBITED_PHRASE);
    expect(result.fallback).toBe(VOCABULARY.HIGH.fallback);
  });

  test('HIGH tier: "perfect fit" is rejected', () => {
    const result = validateNarrative(
      'You are a perfect fit for this role.',
      'HIGH'
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toContain(REJECTION_CODES.PROHIBITED_PHRASE);
  });

  test('MEDIUM tier: "strong alignment" is rejected (escalation)', () => {
    const result = validateNarrative(
      'Your profile shows strong alignment with this direction.',
      'MEDIUM'
    );
    // "strong alignment" is in MEDIUM.prohibited
    expect(result.valid).toBe(false);
  });

  test('LOW tier: "ideal fit" is rejected', () => {
    const result = validateNarrative(
      'You are an ideal fit for this career direction.',
      'LOW'
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toContain(REJECTION_CODES.PROHIBITED_PHRASE);
  });

  test('LOW tier: "highly suited" is rejected', () => {
    const result = validateNarrative(
      'You are highly suited to this domain.',
      'LOW'
    );
    expect(result.valid).toBe(false);
  });

  test('NO_DATA tier: any capability claim is rejected', () => {
    const result = validateNarrative(
      'Your profile suggests some alignment with software engineering.',
      'NO_DATA'
    );
    expect(result.valid).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATOR — length boundary checks
// ─────────────────────────────────────────────────────────────────────────────

describe('Validator — length boundaries', () => {
  test('Empty string is rejected with EMPTY_OUTPUT', () => {
    const result = validateNarrative('', 'HIGH');
    expect(result.valid).toBe(false);
    expect(result.violations).toContain(REJECTION_CODES.EMPTY_OUTPUT);
  });

  test('null is rejected with EMPTY_OUTPUT', () => {
    const result = validateNarrative(null, 'HIGH');
    expect(result.valid).toBe(false);
    expect(result.violations).toContain(REJECTION_CODES.EMPTY_OUTPUT);
  });

  test(`Text below ${VALIDATION_CONFIG.MIN_LENGTH} chars is rejected`, () => {
    const result = validateNarrative('Too short.', 'MEDIUM');
    expect(result.valid).toBe(false);
    expect(result.violations).toContain(REJECTION_CODES.BELOW_MIN_LENGTH);
  });

  test(`Text exceeding ${VALIDATION_CONFIG.MAX_LENGTH} chars is rejected`, () => {
    const long = 'Your profile suggests some alignment with this direction. '.repeat(30);
    expect(long.length).toBeGreaterThan(VALIDATION_CONFIG.MAX_LENGTH);
    const result = validateNarrative(long, 'MEDIUM');
    expect(result.valid).toBe(false);
    expect(result.violations).toContain(REJECTION_CODES.EXCEEDS_MAX_LENGTH);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATOR — unknown tier
// ─────────────────────────────────────────────────────────────────────────────

describe('Validator — unknown tier handling', () => {
  test('Unknown tier returns invalid with UNKNOWN_TIER code', () => {
    const result = validateNarrative('Your profile shows strong alignment.', 'VERY_HIGH');
    expect(result.valid).toBe(false);
    expect(result.violations).toContain(REJECTION_CODES.UNKNOWN_TIER);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATOR — case insensitivity
// ─────────────────────────────────────────────────────────────────────────────

describe('Validator — case insensitive prohibited phrase detection', () => {
  test('Detects "GUARANTEED" in uppercase', () => {
    const result = validateNarrative(
      'This is GUARANTEED to work for you in your career.',
      'HIGH'
    );
    expect(result.valid).toBe(false);
  });

  test('Detects "Perfect Fit" in title case', () => {
    const result = validateNarrative(
      'You are a Perfect Fit for software engineering.',
      'HIGH'
    );
    expect(result.valid).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATOR — fallback copy
// ─────────────────────────────────────────────────────────────────────────────

describe('Validator — fallback copy returned on failure', () => {
  test.each(Object.values(CONFIDENCE_TIERS))(
    'Fallback for %s matches registry fallback',
    (tier) => {
      const result = validateNarrative('', tier);
      expect(result.fallback).toBe(VOCABULARY[tier]?.fallback ?? expect.any(String));
    }
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// BATCH VALIDATOR
// ─────────────────────────────────────────────────────────────────────────────

describe('Batch validator', () => {
  test('Returns one result per input item', () => {
    const items = [
      { narrative: 'Your profile shows strong alignment with this direction.', tier: 'HIGH' },
      { narrative: 'This is guaranteed to succeed.', tier: 'HIGH' },
      { narrative: 'Based on limited data, early signals suggest this may be worth exploring.', tier: 'LOW' },
    ];
    const results = validateBatch(items);
    expect(results).toHaveLength(3);
    expect(results[0].valid).toBe(true);
    expect(results[1].valid).toBe(false);
    expect(results[2].valid).toBe(true);
  });

  test('Returns empty array for non-array input', () => {
    expect(validateBatch(null)).toEqual([]);
    expect(validateBatch('string')).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE — applyToNarrative
// ─────────────────────────────────────────────────────────────────────────────

describe('Service — applyToNarrative', () => {
  const mockAdapter = { emit: jest.fn() };

  beforeEach(() => jest.clearAllMocks());

  test('Approved narrative is returned as-is', () => {
    const service = createConfidenceLanguageService({ adapter: mockAdapter });
    const result = service.applyToNarrative({
      narrative:    'Your profile shows strong alignment with this direction.',
      tier:         'HIGH',
      capability:   'explanation_enhancement',
      promptId:     'test-prompt-v1',
      promptVersion: '1.0.0',
    });
    expect(result.approved).toBe(true);
    expect(result.isFallback).toBe(false);
    expect(result.narrative).toBe('Your profile shows strong alignment with this direction.');
    expect(mockAdapter.emit).toHaveBeenCalledWith(
      TELEMETRY_EVENTS.APPLIED,
      expect.objectContaining({ capability: 'explanation_enhancement', tier: 'HIGH' })
    );
  });

  test('Invalid narrative returns fallback and emits rejection events', () => {
    const service = createConfidenceLanguageService({ adapter: mockAdapter });
    const result = service.applyToNarrative({
      narrative:    'This is guaranteed to be your perfect fit.',
      tier:         'HIGH',
      capability:   'explanation_enhancement',
      promptId:     'test-prompt-v1',
      promptVersion: '1.0.0',
    });
    expect(result.approved).toBe(false);
    expect(result.isFallback).toBe(true);
    expect(result.narrative).toBe(VOCABULARY.HIGH.fallback);
    expect(mockAdapter.emit).toHaveBeenCalledWith(
      TELEMETRY_EVENTS.REJECTED,
      expect.objectContaining({ capability: 'explanation_enhancement' })
    );
    expect(mockAdapter.emit).toHaveBeenCalledWith(
      TELEMETRY_EVENTS.FALLBACK_USED,
      expect.objectContaining({ reason: 'validation_failed' })
    );
  });

  test('getFallbackFor returns tier fallback and emits fallback_used', () => {
    const service = createConfidenceLanguageService({ adapter: mockAdapter });
    const fallback = service.getFallbackFor('LOW', 'explanation_enhancement', 'ai_timeout');
    expect(fallback).toBe(VOCABULARY.LOW.fallback);
    expect(mockAdapter.emit).toHaveBeenCalledWith(
      TELEMETRY_EVENTS.FALLBACK_USED,
      expect.objectContaining({ reason: 'ai_timeout', tier: 'LOW' })
    );
  });

  test('Works without adapter (no throws)', () => {
    const service = createConfidenceLanguageService();  // no adapter
    expect(() =>
      service.applyToNarrative({
        narrative:    'This is guaranteed.',
        tier:         'HIGH',
        capability:   'test',
        promptId:     'p1',
        promptVersion: '1',
      })
    ).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GOVERNANCE INVARIANTS
// ─────────────────────────────────────────────────────────────────────────────

describe('Governance invariants', () => {
  test('Registry does not export any function that generates content', () => {
    const registry = require('../../core/src/ai/confidence-language/ai-confidence-language.registry');
    // Registry may only export: REGISTRY_VERSION, CONFIDENCE_TIERS, VOCABULARY,
    // getPromptGroundingInstructions (returns instruction string, not narrative)
    const exported = Object.keys(registry);
    expect(exported).not.toContain('generateNarrative');
    expect(exported).not.toContain('createNarrative');
    expect(exported).not.toContain('score');
    expect(exported).not.toContain('rank');
  });

  test('Validator is a pure function — same input always same output', () => {
    const input = ['Your profile suggests some alignment with this direction.', 'MEDIUM'];
    const r1 = validateNarrative(...input);
    const r2 = validateNarrative(...input);
    expect(r1).toEqual(r2);
  });

  test('HIGH prohibited phrases include all superlatives that would cause overclaiming', () => {
    const { prohibited } = VOCABULARY.HIGH;
    expect(prohibited).toContain('guaranteed');
    expect(prohibited).toContain('perfect fit');
    expect(prohibited).toContain('certain success');
  });

  test('LOW prohibited phrases include all HIGH alignment language', () => {
    const { prohibited } = VOCABULARY.LOW;
    expect(prohibited).toContain('strong alignment');
    expect(prohibited).toContain('ideal fit');
    expect(prohibited).toContain('highly suited');
  });

  test('NO_DATA prohibited phrases include any skill/capability claim', () => {
    const { prohibited } = VOCABULARY.NO_DATA;
    expect(prohibited).toContain('suggests');
    expect(prohibited).toContain('indicates');
    expect(prohibited).toContain('you are suited');
  });
});
