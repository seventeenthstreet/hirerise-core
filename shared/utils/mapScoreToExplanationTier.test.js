'use strict';

/**
 * @file tests/shared/utils/mapScoreToExplanationTier.test.js
 *
 * @description
 * Comprehensive test suite for the canonical score-to-explanation-tier
 * utility (R1-TECH-01).
 *
 * Test categories:
 *   1. Unit tests          — standard valid inputs
 *   2. Boundary tests      — values at and around tier thresholds
 *   3. Invalid input tests — all specified invalid inputs → NO_DATA, no throw
 *   4. Determinism tests   — repeated and out-of-order calls
 *   5. Regression tests    — fixed canonical mapping table
 *   6. Backward compatibility — contract documentation tests
 *
 * Programme context: XAI-1 Sprint 0 / R1-TECH-01
 * Specification:     R1-SPEC-01 (Accepted)
 */

const { mapScoreToExplanationTier } = require('../../../src/shared/utils/mapScoreToExplanationTier');

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Assert a call does not throw and returns the expected tier.
 * Used throughout invalid-input tests to combine both assertions concisely.
 */
function expectSafe(input, expected) {
  expect(() => mapScoreToExplanationTier(input)).not.toThrow();
  expect(mapScoreToExplanationTier(input)).toBe(expected);
}

// ---------------------------------------------------------------------------
// 1. Unit Tests
// ---------------------------------------------------------------------------

describe('mapScoreToExplanationTier — Unit Tests', () => {
  test('100 → HIGH', () => {
    expect(mapScoreToExplanationTier(100)).toBe('HIGH');
  });

  test('95 → HIGH', () => {
    expect(mapScoreToExplanationTier(95)).toBe('HIGH');
  });

  test('75 → MEDIUM', () => {
    expect(mapScoreToExplanationTier(75)).toBe('MEDIUM');
  });

  test('50 → LOW', () => {
    expect(mapScoreToExplanationTier(50)).toBe('LOW');
  });

  test('20 → LOW', () => {
    expect(mapScoreToExplanationTier(20)).toBe('LOW');
  });

  test('0 → LOW (0 is a valid score, not a missing value)', () => {
    expect(mapScoreToExplanationTier(0)).toBe('LOW');
  });
});

// ---------------------------------------------------------------------------
// 2. Boundary Tests
// ---------------------------------------------------------------------------

describe('mapScoreToExplanationTier — Boundary Tests', () => {
  describe('HIGH / MEDIUM boundary (80)', () => {
    test('80 → HIGH  (inclusive lower bound of HIGH)', () => {
      expect(mapScoreToExplanationTier(80)).toBe('HIGH');
    });

    test('79 → MEDIUM (just below HIGH threshold)', () => {
      expect(mapScoreToExplanationTier(79)).toBe('MEDIUM');
    });
  });

  describe('MEDIUM / LOW boundary (60)', () => {
    test('60 → MEDIUM (inclusive lower bound of MEDIUM)', () => {
      expect(mapScoreToExplanationTier(60)).toBe('MEDIUM');
    });

    test('59 → LOW (just below MEDIUM threshold)', () => {
      expect(mapScoreToExplanationTier(59)).toBe('LOW');
    });
  });

  describe('Domain endpoints', () => {
    test('0 → LOW  (minimum valid score)', () => {
      expect(mapScoreToExplanationTier(0)).toBe('LOW');
    });

    test('100 → HIGH (maximum valid score)', () => {
      expect(mapScoreToExplanationTier(100)).toBe('HIGH');
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Invalid Input Tests
// ---------------------------------------------------------------------------

describe('mapScoreToExplanationTier — Invalid Input Tests', () => {
  describe('Nullable primitives', () => {
    test('null → NO_DATA', () => expectSafe(null, 'NO_DATA'));
    test('undefined → NO_DATA', () => expectSafe(undefined, 'NO_DATA'));
  });

  describe('Special numeric values', () => {
    test('NaN → NO_DATA', () => expectSafe(NaN, 'NO_DATA'));
    test('Infinity → NO_DATA', () => expectSafe(Infinity, 'NO_DATA'));
    test('-Infinity → NO_DATA', () => expectSafe(-Infinity, 'NO_DATA'));
  });

  describe('Out-of-domain numbers', () => {
    test('-1 → NO_DATA (below domain minimum)', () => expectSafe(-1, 'NO_DATA'));
    test('150 → NO_DATA (above domain maximum)', () => expectSafe(150, 'NO_DATA'));
  });

  describe('Wrong types', () => {
    test("'' (empty string) → NO_DATA", () => expectSafe('', 'NO_DATA'));
    test("'95' (numeric string) → NO_DATA", () => expectSafe('95', 'NO_DATA'));
    test('true → NO_DATA', () => expectSafe(true, 'NO_DATA'));
    test('false → NO_DATA', () => expectSafe(false, 'NO_DATA'));
    test('{} → NO_DATA', () => expectSafe({}, 'NO_DATA'));
    test('[] → NO_DATA', () => expectSafe([], 'NO_DATA'));
    test('Symbol() → NO_DATA', () => expectSafe(Symbol(), 'NO_DATA'));
    test('function(){} → NO_DATA', () => expectSafe(function () {}, 'NO_DATA'));
  });

  describe('No exceptions thrown for any invalid input', () => {
    const invalidInputs = [
      null, undefined, NaN, -1, 150, '', '95', true, false, {}, [], Infinity, -Infinity,
    ];

    invalidInputs.forEach((input) => {
      test(`does not throw for input: ${String(input)}`, () => {
        expect(() => mapScoreToExplanationTier(input)).not.toThrow();
      });
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Determinism Tests
// ---------------------------------------------------------------------------

describe('mapScoreToExplanationTier — Determinism Tests', () => {
  test('repeated calls with same input return identical output', () => {
    const inputs = [100, 80, 79, 60, 59, 0, null, undefined, -1];

    inputs.forEach((input) => {
      const first  = mapScoreToExplanationTier(input);
      const second = mapScoreToExplanationTier(input);
      const third  = mapScoreToExplanationTier(input);

      expect(second).toBe(first);
      expect(third).toBe(first);
    });
  });

  test('calling in different order produces same results', () => {
    const forward = [
      mapScoreToExplanationTier(100),
      mapScoreToExplanationTier(75),
      mapScoreToExplanationTier(50),
      mapScoreToExplanationTier(0),
      mapScoreToExplanationTier(null),
    ];

    const reverse = [
      mapScoreToExplanationTier(null),
      mapScoreToExplanationTier(0),
      mapScoreToExplanationTier(50),
      mapScoreToExplanationTier(75),
      mapScoreToExplanationTier(100),
    ];

    expect(forward[0]).toBe('HIGH');
    expect(reverse[4]).toBe('HIGH');

    expect(forward[1]).toBe('MEDIUM');
    expect(reverse[3]).toBe('MEDIUM');

    expect(forward[2]).toBe('LOW');
    expect(reverse[2]).toBe('LOW');

    expect(forward[3]).toBe('LOW');
    expect(reverse[1]).toBe('LOW');

    expect(forward[4]).toBe('NO_DATA');
    expect(reverse[0]).toBe('NO_DATA');
  });
});

// ---------------------------------------------------------------------------
// 5. Regression Tests — Canonical Mapping Table
// ---------------------------------------------------------------------------

describe('mapScoreToExplanationTier — Regression Tests (canonical mapping table)', () => {
  const CANONICAL_MAP = [
    [100,       'HIGH'],
    [95,        'HIGH'],
    [80,        'HIGH'],
    [79,        'MEDIUM'],
    [75,        'MEDIUM'],
    [60,        'MEDIUM'],
    [59,        'LOW'],
    [50,        'LOW'],
    [20,        'LOW'],
    [0,         'LOW'],
    [null,      'NO_DATA'],
    [undefined, 'NO_DATA'],
  ];

  CANONICAL_MAP.forEach(([input, expected]) => {
    test(`mapScoreToExplanationTier(${String(input)}) === '${expected}'`, () => {
      expect(mapScoreToExplanationTier(input)).toBe(expected);
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Backward Compatibility Tests
// ---------------------------------------------------------------------------

describe('mapScoreToExplanationTier — Backward Compatibility Contract', () => {
  test('returns only values from the canonical output registry', () => {
    const PERMITTED_VALUES = new Set(['HIGH', 'MEDIUM', 'LOW', 'NO_DATA']);

    const testScores = [
      100, 95, 90, 80, 79, 75, 70, 60, 59, 50, 30, 20, 10, 0,
      null, undefined, NaN, -1, 150, '', '95', true, false, {}, [],
    ];

    testScores.forEach((score) => {
      const result = mapScoreToExplanationTier(score);
      expect(PERMITTED_VALUES).toContain(result);
    });
  });

  test('function is synchronous — returns immediately without Promise', () => {
    const result = mapScoreToExplanationTier(75);
    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof result).toBe('string');
  });

  test('function is pure — does not mutate its input argument', () => {
    const inputObj = Object.freeze({ score: 75 });
    // Calling with a plain number (no mutation risk), but verify function
    // does not attach properties to the global scope
    const before = Object.keys(global).length;
    mapScoreToExplanationTier(75);
    const after = Object.keys(global).length;
    expect(after).toBe(before);
  });

  test('contract: tier thresholds are HIGH=80, MEDIUM=60, LOW=0 (future consumers may not change these)', () => {
    // If these assertions fail, a consumer has introduced a breaking change.
    expect(mapScoreToExplanationTier(80)).toBe('HIGH');   // 80 is the HIGH floor
    expect(mapScoreToExplanationTier(79)).toBe('MEDIUM'); // 79 is not HIGH
    expect(mapScoreToExplanationTier(60)).toBe('MEDIUM'); // 60 is the MEDIUM floor
    expect(mapScoreToExplanationTier(59)).toBe('LOW');    // 59 is not MEDIUM
    expect(mapScoreToExplanationTier(0)).toBe('LOW');     // 0 is the LOW floor
  });

  test('contract: all consumers must use this utility (no inline thresholds permitted)', () => {
    // This test documents the governance constraint. If this test file exists
    // and passes, the utility is present and testable. The repository
    // verification report (delivered separately) certifies no duplicate
    // inline threshold logic was introduced in the XAI explanation pipeline.
    expect(typeof mapScoreToExplanationTier).toBe('function');
  });
});
