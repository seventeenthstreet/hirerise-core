'use strict';

/**
 * modules/student-onboarding/__tests__/academic-signal-derivation.test.js
 *
 * Phase 3B.2 — Academic Signal Derivation
 *
 * Covers normalizeAcademicSignals() and ACADEMIC_SUBJECT_SIGNAL_MAP from
 * signals/domain-normalizers.js against the real Student v2 academic shape
 * (the year-map produced by academic.repository.js#groupAcademicData()).
 */

const {
  normalizeAcademicSignals,
  ACADEMIC_SUBJECT_SIGNAL_MAP,
} = require('../signals/domain-normalizers');

const { ACADEMIC_SUBJECTS, PREDICTED_EVIDENCE_DISCOUNT } = require('../constants/academics');
const { ALL_SIGNAL_KEYS } = require('../constants/intelligence');

// ─────────────────────────────────────────────────────────────────────────────
// FIXTURE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function makeSubject(overrides = {}) {
  return {
    id:             'subject-id-1',
    subject:        'mathematics',
    marks_obtained: null,
    max_marks:      null,
    grade:          null,
    percentage:     null,
    source_type:    'manual',
    is_predicted:   false,
    ...overrides,
  };
}

function makeYear(overrides = {}) {
  const subjects = overrides.subjects ?? [];
  return {
    academic_year: 'class_10',
    board_type:    'cbse',
    is_partial:    false,
    is_predicted:  false,
    subject_count: subjects.length,
    completed_at:  '2026-01-01T00:00:00.000Z',
    ...overrides,
    subjects,
  };
}

function yearsMap(...years) {
  const map = {};
  for (const y of years) map[y.academic_year] = y;
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// SUBJECT COVERAGE
// ─────────────────────────────────────────────────────────────────────────────

describe('ACADEMIC_SUBJECT_SIGNAL_MAP — subject coverage', () => {
  it('covers every one of the 16 canonical Student v2 subjects (including G5 "science")', () => {
    const mapped = Object.keys(ACADEMIC_SUBJECT_SIGNAL_MAP).sort();
    expect(mapped).toEqual([...ACADEMIC_SUBJECTS].sort());
  });

  // G5 (Phase 1) compatibility fix — see the comment on
  // ACADEMIC_SUBJECT_SIGNAL_MAP in domain-normalizers.js for the full
  // rationale. Short version: before G5, a Class 8–10 student's separate
  // physics/chemistry/biology marks DID produce signal evidence here.
  // Collapsing them into one 'science' subject without a mapping would have
  // silently zeroed out that evidence — a regression introduced by G5, not
  // a pre-existing gap. The frozen spec's stated objective for tracing
  // SUBJECTS_BY_YEAR consumers is to keep Science "consistently represented"
  // through every stage, explicitly including recommendation-input
  // preparation — so this restores participation using the codebase's own
  // pre-existing (now-legacy) 'science' weights, rather than deferring to
  // Phase 2. It reuses those exact numbers rather than inventing a new
  // composition of the retired per-subject weights, so no new weighting
  // design decision was made here — that remains open for Phase 2 to
  // revisit deliberately.
  it('"science" (G5) is mapped using the pre-existing legacy weights, not a newly-invented composition', () => {
    expect(ACADEMIC_SUBJECT_SIGNAL_MAP.science).toEqual([
      ['scientific_orientation', 1.00],
      ['analytical_strength', 0.60],
      ['stem_affinity', 0.85],
    ]);
  });

  it('does not assume "second_language" is a Student v2 subject', () => {
    expect(ACADEMIC_SUBJECT_SIGNAL_MAP.second_language).toBeUndefined();
  });

  it('maps every subject to at least one signal, with multipliers in (0,1]', () => {
    for (const [subject, mappings] of Object.entries(ACADEMIC_SUBJECT_SIGNAL_MAP)) {
      expect(Array.isArray(mappings)).toBe(true);
      expect(mappings.length).toBeGreaterThan(0);
      for (const [signalKey, multiplier] of mappings) {
        expect(typeof signalKey).toBe('string');
        expect(multiplier).toBeGreaterThan(0);
        expect(multiplier).toBeLessThanOrEqual(1);
      }
    }
  });

  it('only references signal keys that exist in the canonical registry', () => {
    for (const mappings of Object.values(ACADEMIC_SUBJECT_SIGNAL_MAP)) {
      for (const [signalKey] of mappings) {
        expect(ALL_SIGNAL_KEYS).toContain(signalKey);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EMPTY / MISSING INPUT
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeAcademicSignals — empty and missing input', () => {
  it('returns [] for null/undefined input', () => {
    expect(normalizeAcademicSignals('user-1', null)).toEqual([]);
    expect(normalizeAcademicSignals('user-1', undefined)).toEqual([]);
  });

  it('returns [] for an empty years map', () => {
    expect(normalizeAcademicSignals('user-1', {})).toEqual([]);
  });

  it('returns [] for a year with no subjects', () => {
    const years = yearsMap(makeYear({ academic_year: 'class_10', subjects: [] }));
    expect(normalizeAcademicSignals('user-1', years)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RECORD STATE — partial / predicted / completed
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeAcademicSignals — record state handling', () => {
  it('excludes subjects belonging to a partial (uncommitted) year', () => {
    const years = yearsMap(makeYear({
      academic_year: 'class_10',
      is_partial:    true,
      subjects:      [makeSubject({ subject: 'mathematics', percentage: 90 })],
    }));
    expect(normalizeAcademicSignals('user-1', years)).toEqual([]);
  });

  it('includes subjects from a committed (non-partial) year', () => {
    const years = yearsMap(makeYear({
      academic_year: 'class_10',
      is_partial:    false,
      subjects:      [makeSubject({ subject: 'mathematics', percentage: 90 })],
    }));
    const result = normalizeAcademicSignals('user-1', years);
    expect(result.length).toBeGreaterThan(0);
  });

  // G5 (Phase 1) compatibility regression test: a Class 8–10 student
  // submitting the new combined 'science' subject must still produce
  // signal evidence — not silently zero, which is what would happen if
  // 'science' were left out of ACADEMIC_SUBJECT_SIGNAL_MAP (the state this
  // codebase was in immediately after the initial G5 taxonomy change,
  // before this compatibility fix).
  it('a Class 8–10 "science" entry produces signal contributions (G5 compatibility fix)', () => {
    const years = yearsMap(makeYear({
      academic_year: 'class_8',
      is_partial:    false,
      subjects:      [makeSubject({ subject: 'science', percentage: 88 })],
    }));
    const result = normalizeAcademicSignals('user-1', years);

    expect(result.length).toBeGreaterThan(0);
    const signalKeys = result.map((c) => c.signal_key).sort();
    expect(signalKeys).toEqual(
      ['analytical_strength', 'scientific_orientation', 'stem_affinity'].sort(),
    );

    const scientificOrientation = result.find((c) => c.signal_key === 'scientific_orientation');
    expect(scientificOrientation.contribution_weight).toBeCloseTo(0.88, 4); // 0.88 * 1.00 multiplier
  });

  it('applies PREDICTED_EVIDENCE_DISCOUNT when the subject row is predicted', () => {
    const completedYears = yearsMap(makeYear({
      academic_year: 'class_10',
      subjects: [makeSubject({ subject: 'mathematics', percentage: 80, is_predicted: false })],
    }));
    const predictedYears = yearsMap(makeYear({
      academic_year: 'class_10',
      subjects: [makeSubject({ subject: 'mathematics', percentage: 80, is_predicted: true })],
    }));

    const completed = normalizeAcademicSignals('user-1', completedYears);
    const predicted  = normalizeAcademicSignals('user-1', predictedYears);

    const completedQR = completed.find((c) => c.signal_key === 'quantitative_reasoning');
    const predictedQR = predicted.find((c) => c.signal_key === 'quantitative_reasoning');

    expect(predictedQR.contribution_weight).toBeCloseTo(
      completedQR.contribution_weight * PREDICTED_EVIDENCE_DISCOUNT,
      4,
    );
    expect(predictedQR.evidence_metadata.is_predicted).toBe(true);
    expect(completedQR.evidence_metadata.is_predicted).toBe(false);
  });

  it('applies the discount when the parent year record is predicted, even if the subject row is not', () => {
    const years = yearsMap(makeYear({
      academic_year: 'class_10',
      is_predicted:  true,
      subjects: [makeSubject({ subject: 'mathematics', percentage: 80, is_predicted: false })],
    }));
    const result = normalizeAcademicSignals('user-1', years);
    const qr = result.find((c) => c.signal_key === 'quantitative_reasoning');
    expect(qr.evidence_metadata.is_predicted).toBe(true);
    expect(qr.evidence_metadata.year_is_predicted).toBe(true);
    expect(qr.evidence_metadata.subject_is_predicted).toBe(false);
    expect(qr.contribution_weight).toBeCloseTo(0.80 * 1.00 * PREDICTED_EVIDENCE_DISCOUNT, 4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PERFORMANCE RESOLUTION — marks/percentage/grade
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeAcademicSignals — performance resolution', () => {
  it('uses the persisted percentage directly when present', () => {
    const years = yearsMap(makeYear({
      subjects: [makeSubject({ subject: 'physics', percentage: 72 })],
    }));
    const result = normalizeAcademicSignals('user-1', years);
    const primary = result.find((c) => c.signal_key === 'scientific_orientation');
    expect(primary.contribution_weight).toBeCloseTo(0.72 * 1.00, 4);
    expect(primary.evidence_metadata.percentage).toBe(72);
  });

  it('falls back to grade-inferred percentage when percentage is null', () => {
    // grade 'A' → GRADE_PERCENTAGE_BANDS.A.midpoint === 84
    const years = yearsMap(makeYear({
      subjects: [makeSubject({ subject: 'english', percentage: null, grade: 'A' })],
    }));
    const result = normalizeAcademicSignals('user-1', years);
    const primary = result.find((c) => c.signal_key === 'language_affinity');
    expect(primary.evidence_metadata.percentage).toBe(84);
    expect(primary.contribution_weight).toBeCloseTo(0.84 * 1.00, 4);
  });

  it('produces no contribution when both percentage and grade are missing', () => {
    const years = yearsMap(makeYear({
      subjects: [makeSubject({ subject: 'chemistry', percentage: null, grade: null })],
    }));
    expect(normalizeAcademicSignals('user-1', years)).toEqual([]);
  });

  it('produces no contribution for marks_obtained/max_marks alone (percentage/grade not resolved)', () => {
    // The repository/normalization layer is responsible for resolving marks
    // into percentage before persistence; this normalizer consumes the
    // already-resolved percentage/grade columns and does not recompute from
    // raw marks. A row with marks but no resolved percentage/grade yields no
    // evidence rather than a guessed one.
    const years = yearsMap(makeYear({
      subjects: [makeSubject({
        subject: 'biology', marks_obtained: 45, max_marks: 50, percentage: null, grade: null,
      })],
    }));
    expect(normalizeAcademicSignals('user-1', years)).toEqual([]);
  });

  it('silently skips an unrecognized subject value rather than guessing', () => {
    const years = yearsMap(makeYear({
      subjects: [makeSubject({ subject: 'not_a_real_subject', percentage: 90 })],
    }));
    expect(normalizeAcademicSignals('user-1', years)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BOUNDARY VALUES
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeAcademicSignals — boundary values', () => {
  it('handles 0% correctly (real evidence of weak performance, not treated as missing)', () => {
    const years = yearsMap(makeYear({
      subjects: [makeSubject({ subject: 'mathematics', percentage: 0 })],
    }));
    const result = normalizeAcademicSignals('user-1', years);
    const qr = result.find((c) => c.signal_key === 'quantitative_reasoning');
    expect(qr).toBeDefined();
    expect(qr.contribution_weight).toBe(0);
  });

  it('handles 100% correctly and clamps at contribution_weight <= 1', () => {
    const years = yearsMap(makeYear({
      subjects: [makeSubject({ subject: 'mathematics', percentage: 100 })],
    }));
    const result = normalizeAcademicSignals('user-1', years);
    for (const c of result) {
      expect(c.contribution_weight).toBeLessThanOrEqual(1);
      expect(c.contribution_weight).toBeGreaterThanOrEqual(0);
    }
  });

  it('every produced contribution_weight stays within the DB CHECK range [0,1]', () => {
    const years = yearsMap(makeYear({
      subjects: ACADEMIC_SUBJECTS.map((subject, i) =>
        makeSubject({ id: `s-${i}`, subject, percentage: (i * 7) % 101 })),
    }));
    const result = normalizeAcademicSignals('user-1', years);
    expect(result.length).toBeGreaterThan(0);
    for (const c of result) {
      expect(c.contribution_weight).toBeGreaterThanOrEqual(0);
      expect(c.contribution_weight).toBeLessThanOrEqual(1);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MULTIPLE ACADEMIC YEARS
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeAcademicSignals — multiple academic years', () => {
  it('produces separate, correctly-tagged evidence for each committed year', () => {
    const years = yearsMap(
      makeYear({ academic_year: 'class_9',  subjects: [makeSubject({ id: 's9', subject: 'mathematics', percentage: 60 })] }),
      makeYear({ academic_year: 'class_10', subjects: [makeSubject({ id: 's10', subject: 'mathematics', percentage: 90 })] }),
    );
    const result = normalizeAcademicSignals('user-1', years);
    const qrContributions = result.filter((c) => c.signal_key === 'quantitative_reasoning');
    expect(qrContributions).toHaveLength(2);
    const years_seen = qrContributions.map((c) => c.evidence_metadata.academic_year).sort();
    expect(years_seen).toEqual(['class_10', 'class_9']);
  });

  it('excludes a partial year while still including a committed year', () => {
    const years = yearsMap(
      makeYear({ academic_year: 'class_9',  is_partial: true,  subjects: [makeSubject({ subject: 'mathematics', percentage: 60 })] }),
      makeYear({ academic_year: 'class_10', is_partial: false, subjects: [makeSubject({ subject: 'mathematics', percentage: 90 })] }),
    );
    const result = normalizeAcademicSignals('user-1', years);
    const academicYearsSeen = new Set(result.map((c) => c.evidence_metadata.academic_year));
    expect(academicYearsSeen.has('class_9')).toBe(false);
    expect(academicYearsSeen.has('class_10')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EVIDENCE METADATA
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeAcademicSignals — evidence metadata', () => {
  it('identifies the source subject, year, and record shape needed for explainability', () => {
    const years = yearsMap(makeYear({
      academic_year: 'class_11',
      board_type:    'icse',
      subjects: [makeSubject({
        id: 'subj-abc', subject: 'commerce', percentage: 77, grade: 'B_plus', source_type: 'ocr',
      })],
    }));
    const result = normalizeAcademicSignals('user-1', years);
    const contribution = result.find((c) => c.signal_key === 'commercial_orientation');

    expect(contribution.source_reference_id).toBe('subj-abc');
    expect(contribution.source_reference_table).toBe('student_academic_subjects');
    expect(contribution.source_domain).toBe('academic');
    expect(contribution.source_type).toBe('subject_performance');
    expect(contribution.evidence_metadata).toMatchObject({
      academic_year: 'class_11',
      board_type:    'icse',
      subject:        'commerce',
      percentage:     77,
      grade:          'B_plus',
      source_type:    'ocr',
      is_predicted:   false,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DETERMINISM
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeAcademicSignals — determinism', () => {
  it('produces identical output for identical input across repeated calls', () => {
    const years = yearsMap(makeYear({
      subjects: [
        makeSubject({ id: 's1', subject: 'mathematics', percentage: 88 }),
        makeSubject({ id: 's2', subject: 'commerce', grade: 'A' }),
      ],
    }));
    const first  = normalizeAcademicSignals('user-1', years);
    const second = normalizeAcademicSignals('user-1', years);
    expect(second).toEqual(first);
  });

  it('is not affected by subject ordering within a year', () => {
    const subjA = makeSubject({ id: 's1', subject: 'mathematics', percentage: 88 });
    const subjB = makeSubject({ id: 's2', subject: 'english', percentage: 70 });

    const years1 = yearsMap(makeYear({ subjects: [subjA, subjB] }));
    const years2 = yearsMap(makeYear({ subjects: [subjB, subjA] }));

    const sortFn = (a, b) => `${a.signal_key}_${a.source_reference_id}`.localeCompare(`${b.signal_key}_${b.source_reference_id}`);

    const result1 = normalizeAcademicSignals('user-1', years1).sort(sortFn);
    const result2 = normalizeAcademicSignals('user-1', years2).sort(sortFn);

    expect(result2).toEqual(result1);
  });
});
