'use strict';

/**
 * modules/student-onboarding/__tests__/activity-signal-derivation.test.js
 *
 * Phase 3B.3 — Activity Signal Derivation
 *
 * Covers:
 *   - activity.signals.js  (normalizeActivitySignal, normalizeAchievement, buildSignalBundle)
 *   - domain-normalizers.js (normalizeActivitySignals, ACTIVITY_CATEGORY_SIGNAL_MAP,
 *     normalizeReflectionSignals)
 *   - intelligence.service.js#filterCommittedActivities (the is_partial gate,
 *     extracted as a pure function for direct testing)
 */

const {
  normalizeActivitySignal,
  normalizeAchievement,
  buildSignalBundle,
} = require('../signals/activity.signals');

const {
  normalizeActivitySignals,
  normalizeReflectionSignals,
  ACTIVITY_CATEGORY_SIGNAL_MAP,
} = require('../signals/domain-normalizers');

const { filterCommittedActivities } = require('../services/intelligence.service');

const { ACTIVITY_CATEGORIES } = require('../constants/activities');
const { ALL_SIGNAL_KEYS } = require('../constants/intelligence');

// ─────────────────────────────────────────────────────────────────────────────
// FIXTURE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function makeActivity(overrides = {}) {
  return {
    id:                'activity-id-1',
    user_id:           'user-1',
    activity_key:      'coding_club',
    activity_category: 'technical',
    proficiency_level: 'proficient',
    duration_months:   6,
    weekly_frequency:  3,
    currently_active:  true,
    leadership_level:  'participant',
    is_partial:        false,
    ...overrides,
  };
}

function makeAchievement(overrides = {}) {
  return {
    id:                    'ach-id-1',
    student_activity_id:   'activity-id-1',
    achievement_title:     'Regional Hackathon',
    achievement_level:     'district',
    achievement_position:  'winner',
    achievement_year:      2025,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CATEGORY COVERAGE
// ─────────────────────────────────────────────────────────────────────────────

describe('ACTIVITY_CATEGORY_SIGNAL_MAP — category coverage', () => {
  it('covers every one of the 6 canonical Student v2 activity categories', () => {
    const mapped = Object.keys(ACTIVITY_CATEGORY_SIGNAL_MAP).sort();
    expect(mapped).toEqual([...ACTIVITY_CATEGORIES].sort());
  });

  it('maps every category to at least one signal, with weights in (0,1]', () => {
    for (const mappings of Object.values(ACTIVITY_CATEGORY_SIGNAL_MAP)) {
      expect(mappings.length).toBeGreaterThan(0);
      for (const [, weight] of mappings) {
        expect(weight).toBeGreaterThan(0);
        expect(weight).toBeLessThanOrEqual(1);
      }
    }
  });

  it('only references signal keys that exist in the canonical registry', () => {
    for (const mappings of Object.values(ACTIVITY_CATEGORY_SIGNAL_MAP)) {
      for (const [signalKey] of mappings) {
        expect(ALL_SIGNAL_KEYS).toContain(signalKey);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PROFICIENCY WEIGHTING
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeActivitySignals — proficiency weighting', () => {
  it('scales contribution_weight up with higher proficiency', () => {
    const beginnerEnvelope = normalizeActivitySignal(makeActivity({ id: 'a1', proficiency_level: 'beginner' }));
    const expertEnvelope   = normalizeActivitySignal(makeActivity({ id: 'a2', proficiency_level: 'expert' }));

    const beginnerResult = normalizeActivitySignals('user-1', [beginnerEnvelope]);
    const expertResult   = normalizeActivitySignals('user-1', [expertEnvelope]);

    const beginnerTE = beginnerResult.find((c) => c.signal_key === 'technical_execution');
    const expertTE   = expertResult.find((c) => c.signal_key === 'technical_execution');

    expect(expertTE.contribution_weight).toBeGreaterThan(beginnerTE.contribution_weight);
  });

  it('applies a 0.20 proficiency floor — even a null/beginner proficiency still contributes', () => {
    const envelope = normalizeActivitySignal(makeActivity({ proficiency_level: null }));
    const result = normalizeActivitySignals('user-1', [envelope]);
    const te = result.find((c) => c.signal_key === 'technical_execution');
    expect(te).toBeDefined();
    expect(te.contribution_weight).toBeCloseTo(1.00 * 0.20, 4);
  });

  it('never exceeds contribution_weight = 1', () => {
    const envelope = normalizeActivitySignal(makeActivity({ proficiency_level: 'expert' }));
    const result = normalizeActivitySignals('user-1', [envelope]);
    for (const c of result) expect(c.contribution_weight).toBeLessThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LEADERSHIP WEIGHTING
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeActivitySignals — leadership weighting', () => {
  it('adds a cross-category leadership contribution when leadership_weight > 2, for a non-leadership category', () => {
    const envelope = normalizeActivitySignal(makeActivity({
      activity_category: 'technical', leadership_level: 'lead', // weight 3 > 2
    }));
    const result = normalizeActivitySignals('user-1', [envelope]);
    const crossLeadership = result.find(
      (c) => c.signal_key === 'leadership' && c.evidence_metadata.reason === 'cross_category_leadership_role',
    );
    expect(crossLeadership).toBeDefined();
  });

  it('does not add a duplicate cross-category leadership contribution for the leadership category itself', () => {
    const envelope = normalizeActivitySignal(makeActivity({
      activity_category: 'leadership', leadership_level: 'captain',
    }));
    const result = normalizeActivitySignals('user-1', [envelope]);
    const crossLeadership = result.find((c) => c.evidence_metadata.reason === 'cross_category_leadership_role');
    expect(crossLeadership).toBeUndefined();
  });

  it('does not add a cross-category leadership contribution at or below the threshold (leadership_weight <= 2)', () => {
    const envelope = normalizeActivitySignal(makeActivity({
      activity_category: 'technical', leadership_level: 'coordinator', // weight 2, not > 2
    }));
    const result = normalizeActivitySignals('user-1', [envelope]);
    const crossLeadership = result.find((c) => c.evidence_metadata.reason === 'cross_category_leadership_role');
    expect(crossLeadership).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DURATION
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeActivitySignals — duration_months → persistence', () => {
  it('produces a persistence contribution proportional to duration, capped at the 24-month ceiling', () => {
    const shortEnvelope = normalizeActivitySignal(makeActivity({ id: 'a1', duration_months: 6 }));
    const longEnvelope   = normalizeActivitySignal(makeActivity({ id: 'a2', duration_months: 30 }));

    const shortResult = normalizeActivitySignals('user-1', [shortEnvelope]);
    const longResult   = normalizeActivitySignals('user-1', [longEnvelope]);

    const shortPersistence = shortResult.find((c) => c.evidence_metadata.reason === 'sustained_participation');
    const longPersistence   = longResult.find((c) => c.evidence_metadata.reason === 'sustained_participation');

    expect(shortPersistence.contribution_weight).toBeCloseTo(6 / 24, 4);
    expect(longPersistence.contribution_weight).toBe(1); // clamped at the 24-month ceiling
  });

  it('produces no duration-based persistence contribution when duration_months is 0 or missing', () => {
    const envelope = normalizeActivitySignal(makeActivity({ duration_months: null }));
    const result = normalizeActivitySignals('user-1', [envelope]);
    const durationPersistence = result.find((c) => c.evidence_metadata?.reason === 'sustained_participation');
    expect(durationPersistence).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WEEKLY FREQUENCY / CURRENTLY ACTIVE (Phase 3B.3 — evidence-only, documented)
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeActivitySignals — weekly_frequency and currently_active', () => {
  it('preserves weekly_frequency_hours in evidence_metadata without it affecting contribution_weight', () => {
    const lowFreq  = normalizeActivitySignal(makeActivity({ id: 'a1', weekly_frequency: 1 }));
    const highFreq = normalizeActivitySignal(makeActivity({ id: 'a2', weekly_frequency: 20 }));

    const lowResult  = normalizeActivitySignals('user-1', [lowFreq]);
    const highResult = normalizeActivitySignals('user-1', [highFreq]);

    const lowTE  = lowResult.find((c) => c.signal_key === 'technical_execution');
    const highTE = highResult.find((c) => c.signal_key === 'technical_execution');

    // Same proficiency/category → identical weight regardless of weekly_frequency,
    // but the raw value is still visible in evidence for later phases.
    expect(highTE.contribution_weight).toBe(lowTE.contribution_weight);
    expect(lowTE.evidence_metadata.weekly_frequency_hours).toBe(1);
    expect(highTE.evidence_metadata.weekly_frequency_hours).toBe(20);
  });

  it('preserves currently_active in evidence_metadata without it affecting contribution_weight', () => {
    const active   = normalizeActivitySignal(makeActivity({ id: 'a1', currently_active: true }));
    const inactive = normalizeActivitySignal(makeActivity({ id: 'a2', currently_active: false }));

    const activeResult   = normalizeActivitySignals('user-1', [active]);
    const inactiveResult = normalizeActivitySignals('user-1', [inactive]);

    const activeTE   = activeResult.find((c) => c.signal_key === 'technical_execution');
    const inactiveTE = inactiveResult.find((c) => c.signal_key === 'technical_execution');

    expect(activeTE.contribution_weight).toBe(inactiveTE.contribution_weight);
    expect(activeTE.evidence_metadata.currently_active).toBe(true);
    expect(inactiveTE.evidence_metadata.currently_active).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ACHIEVEMENTS
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeAchievement / normalizeActivitySignals — achievements', () => {
  it('computes level_weight + position_weight = composite_weight for a raw achievement', () => {
    const signal = normalizeAchievement(makeAchievement({ achievement_level: 'national', achievement_position: 'winner' }));
    expect(signal.level_weight).toBe(5);    // national
    expect(signal.position_weight).toBe(3); // winner
    expect(signal.composite_weight).toBe(8);
  });

  it('produces an achievement_orientation contribution normalized against the 9-point ceiling', () => {
    const envelope = normalizeActivitySignal(
      makeActivity({ id: 'a1' }),
      [makeAchievement({ achievement_level: 'international', achievement_position: 'winner' })], // 6 + 3 = 9
    );
    const result = normalizeActivitySignals('user-1', [envelope]);
    const achievement = result.find((c) => c.signal_key === 'achievement_orientation');
    expect(achievement.contribution_weight).toBe(1); // 9/9
  });

  it('produces no achievement_orientation contribution for a zero-weight achievement (participation/participant)', () => {
    const envelope = normalizeActivitySignal(
      makeActivity({ id: 'a1' }),
      [makeAchievement({ achievement_level: 'participation', achievement_position: 'participant' })], // 0 + 0 = 0
    );
    const result = normalizeActivitySignals('user-1', [envelope]);
    const achievement = result.find((c) => c.signal_key === 'achievement_orientation');
    expect(achievement).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MULTIPLE ACTIVITIES
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeActivitySignals / buildSignalBundle — multiple activities', () => {
  it('aggregates signals across multiple activities without cross-contamination', () => {
    const activities = [
      makeActivity({ id: 'a1', activity_key: 'coding_club', activity_category: 'technical' }),
      makeActivity({ id: 'a2', activity_key: 'debate_team', activity_category: 'social', leadership_level: 'participant' }),
    ];
    const bundle = buildSignalBundle(activities, []);
    expect(bundle.envelopes).toHaveLength(2);
    expect(bundle.byCategory.technical.activity_count).toBe(1);
    expect(bundle.byCategory.social.activity_count).toBe(1);
    expect(bundle.byCategory.athletic.activity_count).toBe(0);

    const result = normalizeActivitySignals('user-1', bundle.envelopes);
    const codingContributions = result.filter((c) => c.evidence_metadata.activity_key === 'coding_club');
    const debateContributions = result.filter((c) => c.evidence_metadata.activity_key === 'debate_team');
    expect(codingContributions.some((c) => c.signal_key === 'technical_execution')).toBe(true);
    expect(debateContributions.some((c) => c.signal_key === 'collaboration')).toBe(true);
    expect(debateContributions.some((c) => c.signal_key === 'technical_execution')).toBe(false);
  });

  it('groups achievements onto the correct parent activity by student_activity_id', () => {
    const activities = [
      makeActivity({ id: 'a1', activity_key: 'coding_club' }),
      makeActivity({ id: 'a2', activity_key: 'robotics_team' }),
    ];
    const achievements = [
      makeAchievement({ id: 'ach1', student_activity_id: 'a1', achievement_level: 'state' }),
      makeAchievement({ id: 'ach2', student_activity_id: 'a2', achievement_level: 'national' }),
    ];
    const bundle = buildSignalBundle(activities, achievements);
    const a1Envelope = bundle.envelopes.find((e) => e.activity_key === 'coding_club');
    const a2Envelope = bundle.envelopes.find((e) => e.activity_key === 'robotics_team');
    expect(a1Envelope.achievements).toHaveLength(1);
    expect(a1Envelope.achievements[0].achievement_level).toBe('state');
    expect(a2Envelope.achievements).toHaveLength(1);
    expect(a2Envelope.achievements[0].achievement_level).toBe('national');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MISSING / PARTIAL DATA
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeActivitySignals — empty and missing input', () => {
  it('returns [] for an empty envelope array', () => {
    expect(normalizeActivitySignals('user-1', [])).toEqual([]);
  });

  it('returns [] for null/undefined envelopes', () => {
    expect(normalizeActivitySignals('user-1', null)).toEqual([]);
    expect(normalizeActivitySignals('user-1', undefined)).toEqual([]);
  });

  it('handles an activity with no achievements gracefully', () => {
    const envelope = normalizeActivitySignal(makeActivity(), []);
    const result = normalizeActivitySignals('user-1', [envelope]);
    expect(result.some((c) => c.signal_key === 'achievement_orientation')).toBe(false);
  });
});

describe('filterCommittedActivities — is_partial gate (Phase 3B.3)', () => {
  it('excludes activities where is_partial is true', () => {
    const activities = [
      makeActivity({ id: 'a1', is_partial: true }),
      makeActivity({ id: 'a2', is_partial: false }),
    ];
    const result = filterCommittedActivities(activities);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a2');
  });

  it('treats missing/undefined is_partial as committed (matches DB default semantics only at the row level — repository always sends an explicit boolean)', () => {
    const activities = [makeActivity({ id: 'a1', is_partial: undefined })];
    const result = filterCommittedActivities(activities);
    expect(result).toHaveLength(1);
  });

  it('returns [] for empty/null/undefined input without throwing', () => {
    expect(filterCommittedActivities([])).toEqual([]);
    expect(filterCommittedActivities(null)).toEqual([]);
    expect(filterCommittedActivities(undefined)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// REFLECTIONS
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeReflectionSignals', () => {
  it('returns [] when there is no reflection data', () => {
    expect(normalizeReflectionSignals('user-1', null)).toEqual([]);
  });

  it('maps pursue_seriously_key to the referenced activity\'s category signals', () => {
    const categoryMap = { coding_club: 'technical' };
    const result = normalizeReflectionSignals('user-1', { pursue_seriously_key: 'coding_club' }, categoryMap);
    expect(result.some((c) => c.signal_key === 'technical_execution')).toBe(true);
    expect(result.every((c) => c.source_type === 'reflection_entry')).toBe(true);
  });

  it('produces persistence + achievement_orientation contributions from proudest_achievement_text', () => {
    const result = normalizeReflectionSignals('user-1', { proudest_achievement_text: 'Won regional finals' }, {});
    expect(result.some((c) => c.signal_key === 'persistence')).toBe(true);
    expect(result.some((c) => c.signal_key === 'achievement_orientation')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE METADATA / EVIDENCE
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeActivitySignals — evidence/source metadata', () => {
  it('identifies the activity as the evidence source using a stable, non-invented identifier', () => {
    const envelope = normalizeActivitySignal(makeActivity({ activity_key: 'robotics_team' }));
    const result = normalizeActivitySignals('user-1', [envelope]);
    for (const c of result) {
      expect(c.source_domain).toBe('activity');
      expect(c.source_reference_table).toBe('student_activities');
      expect(c.source_reference_id).toContain('robotics_team');
      expect(c.evidence_metadata.activity_key).toBe('robotics_team');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NO LEGACY / NO AI DEPENDENCY
// ─────────────────────────────────────────────────────────────────────────────

describe('architecture safety — activity signal module boundaries', () => {
  it('activity.signals.js does not import the legacy free-text activity analyzer or any AI/network client', () => {
    const src = require('fs').readFileSync(
      require.resolve('../signals/activity.signals'), 'utf8',
    );
    expect(src).not.toMatch(/activityAnalyzer\.engine/);
    expect(src).not.toMatch(/anthropic|openai/i);
  });

  it('domain-normalizers.js activity section does not import the legacy recommendation engine or Knowledge Runtime', () => {
    const src = require('fs').readFileSync(
      require.resolve('../signals/domain-normalizers'), 'utf8',
    );
    expect(src).not.toMatch(/recommendation-engine/);
    expect(src).not.toMatch(/knowledge-runtime/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DETERMINISM
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeActivitySignals — determinism', () => {
  it('produces identical output for identical input across repeated calls', () => {
    const envelope = normalizeActivitySignal(
      makeActivity(),
      [makeAchievement()],
    );
    const first  = normalizeActivitySignals('user-1', [envelope]);
    const second = normalizeActivitySignals('user-1', [envelope]);
    expect(second).toEqual(first);
  });
});
