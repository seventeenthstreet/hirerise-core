'use strict';

/**
 * modules/student-onboarding/__tests__/aspiration-signal-derivation.test.js
 *
 * Phase 3B.5B — Aspiration Signalization
 *
 * Covers normalizeAspirationSignals() from signals/domain-normalizers.js
 * against the real Student v2 student_aspirations shape (as returned by
 * aspiration.repository.js#fetchAspiration()):
 *   { career_interests: string[], motivation_driver: string|null,
 *     time_horizon: string|null }
 *
 * Pure function tests — no mocking required.
 */

const {
  normalizeAspirationSignals,
} = require('../signals/domain-normalizers');

const {
  CAREER_DOMAINS,
  MOTIVATION_DRIVERS,
  TIME_HORIZONS,
} = require('../constants/aspiration');

const {
  ASPIRATION_SIGNAL_KEYS,
  ALL_SIGNAL_KEYS,
  SIGNAL_REGISTRY_METADATA,
} = require('../constants/intelligence');

const { validateCareerInterests } = require('../validators/aspiration.validator');

function row(overrides = {}) {
  return {
    career_interests:  [],
    motivation_driver: null,
    time_horizon:      null,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT SHAPE — 16 keys, no more no less
// ─────────────────────────────────────────────────────────────────────────────

describe('ASPIRATION_SIGNAL_KEYS — contract shape', () => {
  it('contains exactly 16 keys', () => {
    expect(ASPIRATION_SIGNAL_KEYS.length).toBe(16);
  });

  it('contains exactly the 11 approved career-interest keys', () => {
    const careerKeys = ASPIRATION_SIGNAL_KEYS.filter((k) => k.startsWith('career_interest_'));
    expect(careerKeys.sort()).toEqual(
      [
        'career_interest_medicine',
        'career_interest_engineering',
        'career_interest_law',
        'career_interest_arts_design',
        'career_interest_business',
        'career_interest_science',
        'career_interest_teaching',
        'career_interest_social',
        'career_interest_defence',
        'career_interest_sports_fitness',
        'career_interest_undecided',
      ].sort(),
    );
  });

  it('contains exactly the 5 approved career-value keys', () => {
    const valueKeys = ASPIRATION_SIGNAL_KEYS.filter((k) => k.startsWith('career_value_'));
    expect(valueKeys.sort()).toEqual(
      [
        'career_value_impact',
        'career_value_financial',
        'career_value_passion',
        'career_value_prestige',
        'career_value_autonomy',
      ].sort(),
    );
  });

  it('has no unexpected 17th/18th key beyond the 16 approved', () => {
    expect(new Set(ASPIRATION_SIGNAL_KEYS).size).toBe(16);
  });

  it('is fully included in ALL_SIGNAL_KEYS with no duplicates', () => {
    for (const key of ASPIRATION_SIGNAL_KEYS) {
      expect(ALL_SIGNAL_KEYS).toContain(key);
    }
    expect(new Set(ALL_SIGNAL_KEYS).size).toBe(ALL_SIGNAL_KEYS.length);
  });

  it('every Aspiration key has registry metadata with the correct contract shape', () => {
    for (const key of ASPIRATION_SIGNAL_KEYS) {
      const meta = SIGNAL_REGISTRY_METADATA[key];
      expect(meta).toBeDefined();
      expect(meta.primary_domain).toBe('aspiration');
      expect(meta.compatible_domains).toEqual(['aspiration']);
      expect(meta.normalization_strategy).toBe('max_pooling');
    }
  });

  it('no non-Aspiration signal declares primary_domain === "aspiration"', () => {
    for (const [key, meta] of Object.entries(SIGNAL_REGISTRY_METADATA)) {
      if (meta.primary_domain === 'aspiration') {
        expect(ASPIRATION_SIGNAL_KEYS).toContain(key);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EMPTY / MISSING INPUT
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeAspirationSignals — empty and missing input', () => {
  it('returns [] for null/undefined input', () => {
    expect(normalizeAspirationSignals('user-1', null)).toEqual([]);
    expect(normalizeAspirationSignals('user-1', undefined)).toEqual([]);
  });

  it('returns [] when career_interests is empty and motivation_driver is null', () => {
    expect(normalizeAspirationSignals('user-1', row())).toEqual([]);
  });

  it('returns [] when career_interests is missing/non-array', () => {
    expect(normalizeAspirationSignals('user-1', { motivation_driver: null })).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A. ONE CAREER-INTEREST SELECTION
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeAspirationSignals — one career interest', () => {
  it('engineering produces exactly one career_interest_engineering = 1.0', () => {
    const result = normalizeAspirationSignals('user-1', row({ career_interests: ['engineering'] }));

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      signal_key:             'career_interest_engineering',
      contribution_weight:    1.0,
      source_domain:          'aspiration',
      source_type:            'explicit_response',
      source_reference_table: 'student_aspirations',
      source_reference_id:    'aspiration_career_interest_engineering',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. MULTIPLE CAREER-INTEREST SELECTIONS
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeAspirationSignals — multiple career interests', () => {
  it('engineering + science + medicine produce exactly those three signals, no cross-contamination', () => {
    const result = normalizeAspirationSignals(
      'user-1',
      row({ career_interests: ['engineering', 'science', 'medicine'] }),
    );

    const keys = result.map((c) => c.signal_key).sort();
    expect(keys).toEqual([
      'career_interest_engineering',
      'career_interest_medicine',
      'career_interest_science',
    ].sort());

    for (const c of result) {
      expect(c.contribution_weight).toBe(1.0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. ALL 10 SUBSTANTIVE INTERESTS
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeAspirationSignals — all 10 substantive career interests', () => {
  it('produces exactly 10 corresponding signals, each weight 1.0', () => {
    const substantive = CAREER_DOMAINS.filter((d) => d !== 'undecided');
    expect(substantive).toHaveLength(10);

    const result = normalizeAspirationSignals('user-1', row({ career_interests: substantive }));

    expect(result).toHaveLength(10);
    const keys = result.map((c) => c.signal_key).sort();
    expect(keys).toEqual(substantive.map((d) => `career_interest_${d}`).sort());
    for (const c of result) {
      expect(c.contribution_weight).toBe(1.0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. UNDECIDED
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeAspirationSignals — undecided', () => {
  it("['undecided'] produces exactly career_interest_undecided = 1.0 and nothing else", () => {
    const result = normalizeAspirationSignals('user-1', row({ career_interests: ['undecided'] }));

    expect(result).toHaveLength(1);
    expect(result[0].signal_key).toBe('career_interest_undecided');
    expect(result[0].contribution_weight).toBe(1.0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. INVALID UNDECIDED COMBINATION — validator-level, not normalizer-level
// ─────────────────────────────────────────────────────────────────────────────

describe('invalid undecided combination — rejected by the existing validator', () => {
  it("the existing validator rejects ['undecided', 'engineering'] (normalizer is not modified to special-case this)", () => {
    expect(() => validateCareerInterests(['undecided', 'engineering'])).toThrow(
      /cannot combine 'undecided'/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CAREER-VALUE (MOTIVATION DRIVER) TESTS
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeAspirationSignals — motivation driver', () => {
  it.each(MOTIVATION_DRIVERS)('motivation_driver = %s produces career_value_%s = 1.0', (driver) => {
    const result = normalizeAspirationSignals('user-1', row({ motivation_driver: driver }));

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      signal_key:             `career_value_${driver}`,
      contribution_weight:    1.0,
      source_domain:          'aspiration',
      source_type:            'explicit_response',
      source_reference_table: 'student_aspirations',
      source_reference_id:    `aspiration_motivation_driver_${driver}`,
    });
  });

  it('motivation_driver = null produces zero career_value_* signals', () => {
    const result = normalizeAspirationSignals('user-1', row({ motivation_driver: null }));
    expect(result.filter((c) => c.signal_key.startsWith('career_value_'))).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TIME-HORIZON — must never be signalized
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeAspirationSignals — time_horizon is never signalized', () => {
  it.each([...TIME_HORIZONS, null])('time_horizon = %s causes zero Aspiration contributions on its own', (th) => {
    const result = normalizeAspirationSignals('user-1', row({ time_horizon: th }));
    expect(result).toEqual([]);
  });

  it('no signal_key produced anywhere starts with time_horizon_ or career_timing_', () => {
    const result = normalizeAspirationSignals(
      'user-1',
      row({ career_interests: ['engineering'], motivation_driver: 'impact', time_horizon: 'short' }),
    );
    for (const c of result) {
      expect(c.signal_key.startsWith('time_horizon_')).toBe(false);
      expect(c.signal_key.startsWith('career_timing_')).toBe(false);
    }
  });

  it('time_horizon is not present anywhere in evidence_metadata', () => {
    const result = normalizeAspirationSignals(
      'user-1',
      row({ career_interests: ['engineering'], motivation_driver: 'impact', time_horizon: 'long' }),
    );
    for (const c of result) {
      expect(Object.keys(c.evidence_metadata)).not.toContain('time_horizon');
      expect(JSON.stringify(c.evidence_metadata)).not.toMatch(/time_horizon/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PROVENANCE — every contribution
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeAspirationSignals — provenance', () => {
  const result = normalizeAspirationSignals(
    'user-1',
    row({ career_interests: ['engineering', 'science'], motivation_driver: 'autonomy' }),
  );

  it('every contribution has the required provenance fields', () => {
    expect(result.length).toBeGreaterThan(0);
    for (const c of result) {
      expect(c.source_domain).toBe('aspiration');
      expect(c.source_type).toBe('explicit_response');
      expect(c.source_reference_table).toBe('student_aspirations');
      expect(typeof c.source_reference_id).toBe('string');
      expect(c.source_reference_id.length).toBeGreaterThan(0);
    }
  });

  it('career-interest source references are deterministic aspiration_career_interest_${domain}', () => {
    const engineering = result.find((c) => c.signal_key === 'career_interest_engineering');
    expect(engineering.source_reference_id).toBe('aspiration_career_interest_engineering');
  });

  it('career-value source references are deterministic aspiration_motivation_driver_${driver}', () => {
    const autonomy = result.find((c) => c.signal_key === 'career_value_autonomy');
    expect(autonomy.source_reference_id).toBe('aspiration_motivation_driver_autonomy');
  });

  it('no source_reference_id looks like a random UUID', () => {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const c of result) {
      expect(uuidRegex.test(c.source_reference_id)).toBe(false);
    }
  });

  it('deterministic: calling twice with the same input yields identical source_reference_ids', () => {
    const rowInput = row({ career_interests: ['law'], motivation_driver: 'prestige' });
    const first  = normalizeAspirationSignals('user-1', rowInput);
    const second = normalizeAspirationSignals('user-1', rowInput);
    expect(first).toEqual(second);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NO INVENTED WEIGHTS / SEMANTICS
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeAspirationSignals — no invented strength/confidence', () => {
  it('every contribution_weight is exactly 1.0 — never fractional, never 0.0', () => {
    const result = normalizeAspirationSignals(
      'user-1',
      row({ career_interests: [...CAREER_DOMAINS.filter((d) => d !== 'undecided')], motivation_driver: 'passion' }),
    );
    for (const c of result) {
      expect(c.contribution_weight).toBe(1.0);
    }
  });

  it('never emits a signal for an unselected career domain', () => {
    const result = normalizeAspirationSignals('user-1', row({ career_interests: ['engineering'] }));
    const keys = result.map((c) => c.signal_key);
    expect(keys).not.toContain('career_interest_medicine');
    expect(keys).not.toContain('career_interest_law');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DEFENSIVE INPUT HANDLING (repository-consistent "skip, do not guess")
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeAspirationSignals — defensive handling of unrecognized values', () => {
  it('silently skips an unrecognized career domain rather than inventing a signal for it', () => {
    const result = normalizeAspirationSignals(
      'user-1',
      row({ career_interests: ['engineering', 'not_a_real_domain'] }),
    );
    expect(result.map((c) => c.signal_key)).toEqual(['career_interest_engineering']);
  });

  it('silently skips an unrecognized motivation_driver rather than inventing a signal for it', () => {
    const result = normalizeAspirationSignals('user-1', row({ motivation_driver: 'not_a_real_driver' }));
    expect(result).toEqual([]);
  });
});
