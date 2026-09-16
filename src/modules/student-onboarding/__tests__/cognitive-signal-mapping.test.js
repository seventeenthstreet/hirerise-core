'use strict';

/**
 * modules/student-onboarding/__tests__/cognitive-signal-mapping.test.js
 *
 * Phase 3B.4D — Family #1 Cognitive Tag Mapping Correction
 *
 * Covers normalizeCognitiveSignals() and COGNITIVE_TAG_SIGNAL_MAP from
 * signals/domain-normalizers.js.
 *
 * Locked scope implemented here (per the 3B.4C-A decision review):
 *   - all 24 previously-correct canonical mappings are preserved exactly,
 *     at their existing weights
 *   - the 3 stale/non-canonical keys (big_picture, context_first,
 *     pattern_recognition) are removed and no longer produce contributions
 *   - exactly one new mapping is added: systems_thinker → systems_thinking @ 1.00
 *   - big_picture_oriented, sequential_thinker, and abstract_thinker remain
 *     deliberately unmapped this checkpoint — this is the approved behavior,
 *     not a gap to "fix" here
 *
 * This file does not touch, import, or exercise cognitive.interpretation.js
 * (3B.4B) — that module is frozen and has its own independent test suite in
 * cognitive-interpretation.test.js, which is not modified here.
 */

const {
  normalizeCognitiveSignals,
  COGNITIVE_TAG_SIGNAL_MAP,
} = require('../signals/domain-normalizers');

const { ALL_COGNITIVE_SIGNAL_TAGS } = require('../constants/cognitive');
const { ALL_SIGNAL_KEYS, SIGNAL_REGISTRY_METADATA } = require('../constants/intelligence');

// ─────────────────────────────────────────────────────────────────────────────
// FIXTURE HELPERS
// (envelope shape mirrors cognitive.signals.js#buildResponseEnvelope output —
// see CognitiveResponseEnvelope jsdoc in that file)
// ─────────────────────────────────────────────────────────────────────────────

function makeEnvelope(overrides = {}) {
  return {
    question_id:          'question-id-1',
    question_key:         'understanding_new_topic',
    domain:                'information_processing',
    selected_option_keys: ['some_option'],
    aggregated_weights:   {},
    ...overrides,
  };
}

function makeBundle(...envelopes) {
  return { envelopes };
}

/** Runs a single tag at a representative weight through the normalizer and
 *  returns just the contributions attributable to that tag. */
function contributionsForTag(tag, tagWeight = 0.7) {
  const bundle = makeBundle(makeEnvelope({ aggregated_weights: { [tag]: tagWeight } }));
  const all = normalizeCognitiveSignals('user-1', bundle);
  return all.filter((c) => c.evidence_metadata.tag === tag);
}

// Ground truth for the 24 mappings this checkpoint must preserve exactly,
// taken verbatim from the pre-3B.4D map (unchanged by this correction).
const PRESERVED_MAPPINGS = Object.freeze({
  analytical:            [['analytical_strength', 1.00], ['structured_problem_solving', 0.60]],
  logic_first:           [['analytical_strength', 0.85], ['structured_problem_solving', 0.80]],
  experimental:          [['exploratory_decision_making', 0.85], ['hands_on_learning', 0.65]],
  iterative:             [['exploratory_decision_making', 0.70]],
  structured:            [['structured_problem_solving', 1.00]],
  intuitive:             [['exploratory_decision_making', 0.75]],
  visual_first:          [['hands_on_learning', 0.60], ['exploratory_decision_making', 0.55]],
  reading_learner:       [['analytical_strength', 0.50]],
  visual_learner:        [['hands_on_learning', 0.55]],
  hands_on_learner:      [['hands_on_learning', 1.00], ['technical_execution', 0.50]],
  guided_learner:        [['structured_problem_solving', 0.55]],
  independent_explorer:  [['independent_working', 1.00], ['exploratory_decision_making', 0.60]],
  collaborative_learner: [['collaboration', 0.90]],
  fast_decider:          [['rapid_execution', 0.90]],
  research_heavy:        [['detail_orientation', 0.85], ['analytical_strength', 0.60]],
  risk_balanced:         [['entrepreneurial_signal', 0.50]],
  exploratory_decider:   [['exploratory_decision_making', 1.00]],
  certainty_seeker:      [['detail_orientation', 0.80], ['structured_problem_solving', 0.55]],
  planner:               [['structured_problem_solving', 0.85], ['detail_orientation', 0.65]],
  rapid_executor:        [['rapid_execution', 1.00]],
  perfection_oriented:   [['detail_orientation', 1.00]],
  adaptive_worker:       [['exploratory_decision_making', 0.65]],
  multitask_oriented:    [['rapid_execution', 0.70]],
  detail_focused:        [['detail_orientation', 0.90], ['analytical_strength', 0.40]],
});

const APPROVED_ADDITION = Object.freeze({
  systems_thinker: [['systems_thinking', 1.00]],
});

const DELIBERATELY_UNMAPPED = Object.freeze(['big_picture_oriented', 'sequential_thinker', 'abstract_thinker']);

const STALE_KEYS = Object.freeze(['big_picture', 'context_first', 'pattern_recognition']);

// ─────────────────────────────────────────────────────────────────────────────
// TEST GROUP A — ALL 28 CANONICAL TAGS, per-tag
// ─────────────────────────────────────────────────────────────────────────────

describe('Test Group A — all 28 canonical tags produce a contribution iff mapped', () => {
  it('taxonomy sanity: 28 canonical tags = 24 preserved + 1 approved + 3 deferred', () => {
    expect(ALL_COGNITIVE_SIGNAL_TAGS).toHaveLength(28);
    const accountedFor = [
      ...Object.keys(PRESERVED_MAPPINGS),
      ...Object.keys(APPROVED_ADDITION),
      ...DELIBERATELY_UNMAPPED,
    ];
    expect(accountedFor.sort()).toEqual([...ALL_COGNITIVE_SIGNAL_TAGS].sort());
  });

  describe.each(Object.entries(PRESERVED_MAPPINGS))('previously-correct tag: %s', (tag, expectedMappings) => {
    it(`produces a contribution for each of its ${expectedMappings.length} target signal(s)`, () => {
      const contributions = contributionsForTag(tag, 0.7);
      expect(contributions).toHaveLength(expectedMappings.length);

      const bySignal = Object.fromEntries(contributions.map((c) => [c.signal_key, c]));
      for (const [signalKey, multiplier] of expectedMappings) {
        expect(bySignal[signalKey]).toBeDefined();
        expect(bySignal[signalKey].contribution_weight).toBeCloseTo(0.7 * multiplier, 4);
      }
    });
  });

  it('systems_thinker now produces its approved contribution', () => {
    const contributions = contributionsForTag('systems_thinker', 0.7);
    expect(contributions).toHaveLength(1);
    expect(contributions[0].signal_key).toBe('systems_thinking');
    expect(contributions[0].contribution_weight).toBeCloseTo(0.7 * 1.00, 4);
  });

  describe.each(DELIBERATELY_UNMAPPED)('deliberately unmapped tag: %s', (tag) => {
    it('produces no Family #1 contribution — this is the approved behavior, not a failure', () => {
      expect(contributionsForTag(tag, 0.7)).toHaveLength(0);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST GROUP B — EXACT NEW MAPPING (actual normalized contribution shape)
// ─────────────────────────────────────────────────────────────────────────────

describe('Test Group B — exact new mapping: systems_thinker → systems_thinking @ 1.00', () => {
  it('produces a fully-shaped SignalContribution, not just "something"', () => {
    const bundle = makeBundle(
      makeEnvelope({
        question_id:          'q-systems-1',
        question_key:         'hard_problem_approach',
        domain:                'problem_solving',
        selected_option_keys: ['break_system'],
        aggregated_weights:   { systems_thinker: 0.8 },
      }),
    );

    const contributions = normalizeCognitiveSignals('user-1', bundle);
    expect(contributions).toHaveLength(1);

    const c = contributions[0];
    expect(c.signal_key).toBe('systems_thinking');
    expect(c.source_domain).toBe('cognitive');
    expect(c.source_reference_id).toBe('question_q-systems-1');
    expect(c.source_reference_table).toBe('student_cognitive_responses');
    expect(c.contribution_weight).toBeCloseTo(0.8, 4); // 0.8 * 1.00
    expect(c.evidence_metadata.tag).toBe('systems_thinker');
    expect(c.evidence_metadata.tag_weight).toBe(0.8);
    expect(c.evidence_metadata.multiplier).toBe(1.00);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST GROUP C — STALE KEYS NO LONGER USABLE
// (COGNITIVE_TAG_SIGNAL_MAP is a genuine module export, not an internal
// exposed solely for testing — asserting against it directly is asserting
// against real observable module behavior. Also verified end-to-end through
// normalizeCognitiveSignals for behavioral confirmation.)
// ─────────────────────────────────────────────────────────────────────────────

describe('Test Group C — stale keys are no longer usable map keys', () => {
  it.each(STALE_KEYS)('%s is absent from the exported COGNITIVE_TAG_SIGNAL_MAP', (staleKey) => {
    expect(Object.prototype.hasOwnProperty.call(COGNITIVE_TAG_SIGNAL_MAP, staleKey)).toBe(false);
  });

  it('none of the stale keys are canonical cognitive signal tags', () => {
    for (const staleKey of STALE_KEYS) {
      expect(ALL_COGNITIVE_SIGNAL_TAGS).not.toContain(staleKey);
    }
  });

  it('feeding stale-key-shaped evidence through normalizeCognitiveSignals yields no contributions', () => {
    const bundle = makeBundle(
      makeEnvelope({
        selected_option_keys: ['big_picture'],
        aggregated_weights: {
          big_picture:         0.9,
          context_first:       0.85,
          pattern_recognition: 0.75,
        },
      }),
    );

    expect(normalizeCognitiveSignals('user-1', bundle)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST GROUP D — DEFERRED TAGS
// ─────────────────────────────────────────────────────────────────────────────

describe('Test Group D — deferred tags produce no Family #1 contribution (intentional)', () => {
  // big_picture_oriented, sequential_thinker, and abstract_thinker are
  // deliberately unmapped in this checkpoint, per the 3B.4C-A decision
  // review: no existing Family #1 signal was judged a sufficiently safe,
  // unambiguous target for them. This is deferred pending a future
  // Family #1 signal-vocabulary expansion / architecture review — it is
  // NOT a bug, and these assertions must never be "fixed" by adding an
  // arbitrary mapping here.

  it('big_picture_oriented → no Family #1 contribution (deliberately unmapped)', () => {
    expect(contributionsForTag('big_picture_oriented', 0.9)).toHaveLength(0);
  });

  it('sequential_thinker → no Family #1 contribution (deliberately unmapped)', () => {
    expect(contributionsForTag('sequential_thinker', 0.9)).toHaveLength(0);
  });

  it('abstract_thinker → no Family #1 contribution (deliberately unmapped)', () => {
    expect(contributionsForTag('abstract_thinker', 0.9)).toHaveLength(0);
  });

  it('a mixed bundle of only deferred tags plus one mapped tag only ever emits the mapped one', () => {
    const bundle = makeBundle(
      makeEnvelope({
        aggregated_weights: {
          big_picture_oriented: 0.9,
          sequential_thinker:   0.6,
          abstract_thinker:     0.8,
          systems_thinker:      0.7, // the one mapped tag in the mix
        },
      }),
    );

    const contributions = normalizeCognitiveSignals('user-1', bundle);
    expect(contributions).toHaveLength(1);
    expect(contributions[0].evidence_metadata.tag).toBe('systems_thinker');
    expect(contributions[0].signal_key).toBe('systems_thinking');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST GROUP E — EXISTING 24 MAPPINGS UNCHANGED
// ─────────────────────────────────────────────────────────────────────────────

describe('Test Group E — all 24 previously-correct mappings remain unchanged', () => {
  it('COGNITIVE_TAG_SIGNAL_MAP retains exactly the 24 preserved entries, byte-for-byte', () => {
    expect(Object.keys(PRESERVED_MAPPINGS)).toHaveLength(24);
    for (const [tag, expected] of Object.entries(PRESERVED_MAPPINGS)) {
      expect(COGNITIVE_TAG_SIGNAL_MAP[tag]).toEqual(expected);
    }
  });

  it('the map has exactly 25 keys total (24 preserved + 1 approved addition)', () => {
    expect(Object.keys(COGNITIVE_TAG_SIGNAL_MAP)).toHaveLength(25);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST GROUP F — TARGET SIGNAL TAXONOMY SAFETY
// ─────────────────────────────────────────────────────────────────────────────

describe('Test Group F — every target signal_key is a registered Family #1 signal', () => {
  it('every target signal_key across the corrected map is a member of ALL_SIGNAL_KEYS', () => {
    for (const mappings of Object.values(COGNITIVE_TAG_SIGNAL_MAP)) {
      for (const [signalKey] of mappings) {
        expect(ALL_SIGNAL_KEYS).toContain(signalKey);
      }
    }
  });

  it('systems_thinking (the new target) is explicitly registered and cognitive-compatible', () => {
    expect(ALL_SIGNAL_KEYS).toContain('systems_thinking');
    const meta = SIGNAL_REGISTRY_METADATA.systems_thinking;
    expect(meta).toBeDefined();
    expect(meta.compatible_domains).toContain('cognitive');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST GROUP G — DETERMINISM
// ─────────────────────────────────────────────────────────────────────────────

describe('Test Group G — determinism', () => {
  it('identical input produces identical output across repeated calls', () => {
    const bundle = makeBundle(
      makeEnvelope({
        aggregated_weights: { systems_thinker: 0.8, analytical: 0.65, detail_focused: 0.5 },
      }),
    );

    const first = normalizeCognitiveSignals('user-1', bundle);
    const second = normalizeCognitiveSignals('user-1', bundle);

    expect(first).toEqual(second);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST GROUP H — INPUT IMMUTABILITY
// ─────────────────────────────────────────────────────────────────────────────

describe('Test Group H — input immutability', () => {
  it('does not mutate the supplied cognitive bundle', () => {
    const bundle = makeBundle(
      makeEnvelope({
        aggregated_weights: { systems_thinker: 0.8, detail_focused: 0.6 },
      }),
    );
    const snapshot = JSON.parse(JSON.stringify(bundle));

    normalizeCognitiveSignals('user-1', bundle);

    expect(bundle).toEqual(snapshot);
  });

  it('handles empty/missing envelope lists without throwing', () => {
    expect(normalizeCognitiveSignals('user-1', { envelopes: [] })).toEqual([]);
    expect(normalizeCognitiveSignals('user-1', {})).toEqual([]);
    expect(normalizeCognitiveSignals('user-1', null)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST GROUP I — WEIGHT PRESERVATION
// ─────────────────────────────────────────────────────────────────────────────

describe('Test Group I — weight preservation', () => {
  it('systems_thinker → systems_thinking is exactly weight 1.00', () => {
    expect(COGNITIVE_TAG_SIGNAL_MAP.systems_thinker).toEqual([['systems_thinking', 1.00]]);
  });

  it('all 24 existing mappings retain their current weights exactly', () => {
    for (const [tag, expected] of Object.entries(PRESERVED_MAPPINGS)) {
      expect(COGNITIVE_TAG_SIGNAL_MAP[tag]).toEqual(expected);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SNAPSHOT — locks the full corrected map against accidental future edits
// ─────────────────────────────────────────────────────────────────────────────

describe('COGNITIVE_TAG_SIGNAL_MAP — snapshot lock', () => {
  it('matches the Phase 3B.4D-corrected map exactly', () => {
    expect(COGNITIVE_TAG_SIGNAL_MAP).toMatchSnapshot();
  });
});
