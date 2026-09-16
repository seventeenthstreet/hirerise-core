'use strict';

/**
 * src/modules/student-onboarding/signals/domain-normalizers.js
 *
 * Phase 3D — Cross-Domain Intelligence Layer
 * DOMAIN SIGNAL NORMALIZERS
 *
 * PURPOSE:
 *   Transform raw domain-specific data (from Phase 3A/3B/3C) into
 *   standardized SignalContribution objects ready for cross-domain aggregation.
 *
 * CRITICAL RULES:
 *   ✗ DO NOT implement scoring, recommendations, or career matching.
 *   ✗ DO NOT read from or write to the DB — pure transformation functions.
 *   ✗ DO NOT call other services.
 *   ✓ Accept raw domain data, return typed SignalContributions.
 *   ✓ Assign contribution_weight values in [0,1] using domain-specific rules.
 *   ✓ Populate evidence_metadata for full traceability.
 *   ✓ Support append-only evidence architecture.
 *
 * ARCHITECTURE:
 *   Each normalizer produces an array of SignalContribution objects.
 *   These are consumed by the aggregation service to:
 *     1. Persist as student_signal_evidence rows (append-only).
 *     2. Fold into student_signal_vectors via the aggregation strategy.
 *
 * @typedef {Object} SignalContribution
 * @property {string} signal_key            — from CANONICAL_SIGNAL_KEYS
 * @property {string} source_type           — evidence_source_enum value
 * @property {string} source_domain         — intelligence_domain_enum value
 * @property {string} source_reference_id   — opaque reference to source row
 * @property {string} [source_reference_table]
 * @property {number} contribution_weight   — normalized [0,1]
 * @property {Object} evidence_metadata     — source-specific detail blob
 * @property {string} taxonomy_version
 * @property {string} aggregation_version
 *
 * Phase 3B.1 note: this contract was reviewed against the real Student v2
 * academic schema and found sufficient as-is — no new signal envelope/type
 * was introduced. It is reused unchanged by the Phase 3B.2 academic
 * normalizer below.
 */

const {
  EVIDENCE_SOURCE_TYPES,
  TAXONOMY_VERSION,
  AGGREGATION_VERSION,
} = require('../constants/intelligence');
const {
  PREDICTED_EVIDENCE_DISCOUNT,
} = require('../constants/academics');
const {
  inferPercentageFromGrade,
} = require('../helpers/academic-normalization');
const {
  CAREER_DOMAINS,
  MOTIVATION_DRIVERS,
} = require('../constants/aspiration');

// ─────────────────────────────────────────────────────────────────────────────
// [LEGACY / SUPERSEDED — Phase 3D]
//
// These constants described a "current_band" (weak/average/strong/excellent)
// and a 5-subject taxonomy (including "science" and "second_language") that
// did not exist in the Student v2 schema at the time this section was
// written. student_academic_subjects has no band column, and — at the time —
// the canonical taxonomy had no "science" or "second_language" entries (see
// constants/academics.js#ACADEMIC_SUBJECTS).
//
// G5 (Phase 1) update: 'science' was reintroduced to ACADEMIC_SUBJECTS as
// the single Class 8–10 combined-Science subject. ACADEMIC_SUBJECT_SIGNAL_MAP
// below now references this object's `.science` entry directly as a Phase 1
// compatibility restoration (see the comment on ACADEMIC_SUBJECT_SIGNAL_MAP).
// This whole block is kept for historical reference — never delete evidence
// of prior architecture — and its `_LEGACY_PHASE3D_SUBJECT_SIGNAL_MAP.science`
// entry is now the one live exception to "unused"; every other entry here
// (including `second_language`, and this block's band weights) remains
// unused/superseded exactly as before.
// ─────────────────────────────────────────────────────────────────────────────

const _LEGACY_PHASE3D_ACADEMIC_BAND_WEIGHTS = Object.freeze({
  weak:      0.15,
  average:   0.40,
  strong:    0.70,
  excellent: 1.00,
});

const _LEGACY_PHASE3D_SUBJECT_SIGNAL_MAP = Object.freeze({
  mathematics:     [
    ['quantitative_reasoning', 1.00],
    ['analytical_strength',    0.75],
    ['stem_affinity',          0.80],
  ],
  science:         [
    ['scientific_orientation', 1.00],
    ['analytical_strength',    0.60],
    ['stem_affinity',          0.85],
  ],
  english:         [
    ['language_affinity',      1.00],
    ['communication_strength', 0.70],
  ],
  social_science:  [
    ['social_science_interest', 1.00],
    ['analytical_strength',     0.40],
  ],
  second_language: [
    ['language_affinity',      0.50],
    ['communication_strength', 0.40],
  ],
});

// ─────────────────────────────────────────────────────────────────────────────
// ACADEMIC SIGNAL NORMALIZER — Phase 3B.2
//
// Input: the year-map produced by
//   academic.repository.js#groupAcademicData(records, subjects)
// i.e. the real, already-canonical Student v2 shape — reused rather than
// re-derived, per the "don't duplicate repository calculations" rule.
//
// Output: SignalContribution[] for academic-domain signals.
//
// PERFORMANCE MODEL:
//   Student v2 stores no performance "band" (weak/average/strong/excellent —
//   that was Phase 3D-only and never existed in the DB). The one existing,
//   already-canonical grading convention found in the repository is
//   constants/academics.js#GRADE_PERCENTAGE_BANDS (A_plus..F, each with a
//   documented percentage range and midpoint), already used by
//   helpers/academic-normalization.js to resolve percentage from grade at
//   submission time.
//
//   Rather than re-bucket that continuous percentage into a *new* set of
//   discrete bands (which would both invent an unrequested convention and
//   throw away real information), this normalizer uses percentage directly
//   as a continuous, deterministic, bounded, monotonic performance strength:
//     base_strength = clamp(percentage, 0, 100) / 100
//   When a subject has no persisted percentage (e.g. grade-only entry),
//   percentage is resolved via the existing inferPercentageFromGrade()
//   helper (same GRADE_PERCENTAGE_BANDS midpoints already used at save time)
//   rather than reimplementing grade→percentage logic here.
//
// PREDICTED EVIDENCE:
//   A subject or its parent year record may be flagged is_predicted (result
//   not yet officially declared). No existing weighting convention for this
//   was found in the repository, so PREDICTED_EVIDENCE_DISCOUNT (see
//   constants/academics.js) — a flat, documented 0.85x multiplier — is
//   applied. This is recorded in evidence_metadata so it is always visible,
//   never silently blended with completed-result evidence.
//
// SUBJECT → SIGNAL MAPPING (all 15 Student v2 subjects; see checkpoint report
// for the full table and rationale):
//   • STEM subjects (mathematics/physics/chemistry/biology/computer_science)
//     map onto the existing quantitative_reasoning / scientific_orientation /
//     analytical_strength / stem_affinity / technical_execution keys — all
//     pre-existing and already declared academic-compatible in
//     constants/intelligence.js#SIGNAL_REGISTRY_METADATA.
//   • english / language_optional map onto the existing language_affinity
//     (+ communication_strength for english specifically).
//   • social_science / history / geography / political_science map onto the
//     existing social_science_interest.
//   • economics / commerce / accountancy / business_studies have no
//     pre-existing signal (the old 5-key set had no commerce/business
//     concept at all) — the registry was searched for a near-duplicate and
//     none was found, so the single new key `commercial_orientation` was
//     added (see constants/intelligence.js).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps each Student v2 academic subject to one or more signal contributions.
 * Each entry is [signal_key, weight_multiplier], multiplier in [0,1].
 * Weight = base_strength (percentage/100) * multiplier * predicted_discount.
 *
 * Every key in constants/academics.js#ACADEMIC_SUBJECTS must appear here —
 * enforced by a dedicated test — so no subject is silently dropped.
 *
 * G5 (Phase 1) COMPATIBILITY NOTE — 'science':
 *   The frozen G5 spec's stated objective for tracing SUBJECTS_BY_YEAR
 *   consumers is to "ensure that Classes 8–10 consistently represent
 *   Science as one subject" through every stage, explicitly including
 *   "any recommendation-input preparation" — this signal-derivation step.
 *   Before G5, a Class 8–10 student's physics/chemistry/biology marks DID
 *   produce real signal evidence here (each subject had its own row above).
 *   Collapsing those three into 'science' without a mapping would silently
 *   zero out that evidence for every Class 8–10 student going forward —
 *   a functional regression introduced by the G5 change itself, not a
 *   pre-existing gap deferrable to Phase 2.
 *
 *   This is therefore a Phase 1 compatibility fix, not a Phase 2 weighting
 *   decision: 'science' is mapped to the EXACT SAME values this codebase
 *   already declared for it previously, in
 *   _LEGACY_PHASE3D_SUBJECT_SIGNAL_MAP.science above (from the pre-Student-v2
 *   5-subject taxonomy, before the split into physics/chemistry/biology).
 *   No new weight, signal key, or composition rule (e.g. an average/max of
 *   the three retired per-subject rows) was invented — that kind of design
 *   decision is left for Phase 2, which may choose to revisit this value
 *   once Classes 8–10 vs 11–12 subject semantics are formally reconciled.
 *   Referencing the legacy object directly (rather than re-typing the
 *   numbers) keeps the two declarations from silently drifting apart.
 */
const ACADEMIC_SUBJECT_SIGNAL_MAP = Object.freeze({
  mathematics:        [['quantitative_reasoning', 1.00], ['analytical_strength', 0.75], ['stem_affinity', 0.85]],
  science:            _LEGACY_PHASE3D_SUBJECT_SIGNAL_MAP.science, // G5 Phase 1 compatibility restoration — see note above
  physics:            [['scientific_orientation', 1.00], ['analytical_strength', 0.70], ['stem_affinity', 0.85]],
  chemistry:          [['scientific_orientation', 1.00], ['analytical_strength', 0.65], ['stem_affinity', 0.80]],
  biology:            [['scientific_orientation', 1.00], ['stem_affinity', 0.70]],
  computer_science:   [['technical_execution', 0.90], ['quantitative_reasoning', 0.65], ['stem_affinity', 0.85]],
  english:            [['language_affinity', 1.00], ['communication_strength', 0.70]],
  social_science:     [['social_science_interest', 1.00]],
  economics:          [['commercial_orientation', 1.00], ['analytical_strength', 0.50]],
  commerce:           [['commercial_orientation', 1.00]],
  accountancy:        [['commercial_orientation', 0.90], ['analytical_strength', 0.55]],
  business_studies:   [['commercial_orientation', 1.00]],
  history:            [['social_science_interest', 1.00]],
  geography:          [['social_science_interest', 1.00]],
  political_science:  [['social_science_interest', 1.00]],
  language_optional:  [['language_affinity', 0.85]],
});

/**
 * @typedef {Object} AcademicYearGroup  — one entry of groupAcademicData()'s return value
 * @property {string}  academic_year
 * @property {string}  board_type
 * @property {boolean} is_partial
 * @property {boolean} is_predicted
 * @property {number}  subject_count
 * @property {string|null} completed_at
 * @property {Array<{
 *   id: string,
 *   subject: string,
 *   marks_obtained: number|null,
 *   max_marks: number|null,
 *   grade: string|null,
 *   percentage: number|null,
 *   source_type: string,
 *   is_predicted: boolean,
 * }>} subjects
 */

/**
 * Normalizes a student's academic data into SignalContribution records.
 *
 * @param {string} userId
 * @param {Record<string, AcademicYearGroup>} academicYears
 *   The year-map produced by academic.repository.js#groupAcademicData().
 * @returns {SignalContribution[]}
 */
function normalizeAcademicSignals(userId, academicYears) {
  if (!academicYears || typeof academicYears !== 'object') {
    return [];
  }

  const contributions = [];

  for (const year of Object.values(academicYears)) {
    if (!year || year.is_partial !== false) continue; // committed (non-partial) years only

    if (!Array.isArray(year.subjects) || year.subjects.length === 0) continue;

    for (const subject of year.subjects) {
      const signalMappings = ACADEMIC_SUBJECT_SIGNAL_MAP[subject.subject];
      if (!signalMappings) continue; // unrecognized subject — skip, do not guess

      // Resolve performance percentage: prefer the persisted value; fall back
      // to the existing grade→percentage inference helper for grade-only rows.
      let percentage = subject.percentage;
      if (percentage === null || percentage === undefined) {
        percentage = inferPercentageFromGrade(subject.grade);
      }
      if (percentage === null || percentage === undefined) continue; // no usable performance data — not evidence

      const pct = Number(percentage);
      if (!Number.isFinite(pct)) continue;

      const baseStrength = Math.min(Math.max(pct, 0), 100) / 100;

      const isPredicted = subject.is_predicted === true || year.is_predicted === true;
      const evidenceDiscount = isPredicted ? PREDICTED_EVIDENCE_DISCOUNT : 1.0;

      for (const [signalKey, multiplier] of signalMappings) {
        const contributionWeight = parseFloat(
          Math.min(Math.max(baseStrength * multiplier * evidenceDiscount, 0), 1.0).toFixed(4),
        );

        contributions.push({
          signal_key:             signalKey,
          source_type:            EVIDENCE_SOURCE_TYPES[3], // 'subject_performance'
          source_domain:          'academic',
          source_reference_id:    subject.id ?? `subject_${subject.subject}_${year.academic_year}`,
          source_reference_table: 'student_academic_subjects',
          contribution_weight:    contributionWeight,
          evidence_metadata: {
            academic_year:         year.academic_year,
            board_type:            year.board_type,
            subject:                subject.subject,
            marks_obtained:        subject.marks_obtained ?? null,
            max_marks:             subject.max_marks ?? null,
            percentage:            pct,
            grade:                 subject.grade ?? null,
            source_type:           subject.source_type ?? 'manual',
            subject_is_predicted:  subject.is_predicted === true,
            year_is_predicted:     year.is_predicted === true,
            is_predicted:          isPredicted,
            evidence_discount_applied: evidenceDiscount,
            base_strength:         baseStrength,
            multiplier,
          },
          taxonomy_version:    TAXONOMY_VERSION,
          aggregation_version: AGGREGATION_VERSION,
        });
      }
    }
  }

  return contributions;
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVITY SIGNAL NORMALIZER
//
// Input: ActivitySignalEnvelope[] (from activity.signals.js buildSignalBundle)
// Output: SignalContribution[] for activity-domain signals
//
// Mapping rules:
//   technical activities  → technical_execution, stem_affinity, systems_thinking
//   creative activities   → creative_expression, entrepreneurial_signal
//   leadership activities → leadership, entrepreneurial_signal, collaboration
//   academic activities   → analytical_strength, persistence
//   social activities     → collaboration, communication_strength
//   athletic activities   → persistence, achievement_orientation
//   leadership_weight > 2 → leadership (all categories)
//   duration_months       → persistence weight contribution
//   achievement composite → achievement_orientation weight contribution
//
// Phase 3B.3 notes:
//   • Caller contract (intelligence.service.js) now passes only committed
//     (is_partial === false) activities into buildSignalBundle — this
//     normalizer itself has no is_partial concept (envelopes don't carry
//     it), so the filter is applied one layer up, at the same orchestration
//     point where the analogous academic "committed years only" filter
//     lives.
//   • weekly_frequency_hours is preserved in evidence_metadata for
//     explainability but does not currently modulate contribution_weight.
//     No existing repository convention was found for combining weekly
//     frequency with duration_months into a single strength value, so none
//     was invented here — see the 3B.3 checkpoint report's Deferred
//     Findings for this open product question.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Activity category → primary signal mappings.
 * Each entry: [signal_key, base_weight].
 * Final weight is modulated by proficiency_weight (0–5) scaled to [0,1].
 */
const ACTIVITY_CATEGORY_SIGNAL_MAP = Object.freeze({
  technical:  [
    ['technical_execution', 1.00],
    ['stem_affinity',       0.80],
    ['systems_thinking',    0.55],
  ],
  creative:   [
    ['creative_expression',   1.00],
    ['entrepreneurial_signal', 0.50],
  ],
  leadership: [
    ['leadership',             1.00],
    ['entrepreneurial_signal', 0.65],
    ['collaboration',          0.55],
  ],
  academic:   [
    ['analytical_strength',   0.75],
    ['persistence',           0.60],
  ],
  social:     [
    ['collaboration',         1.00],
    ['communication_strength', 0.65],
    ['leadership',            0.40],
  ],
  athletic:   [
    ['persistence',            1.00],
    ['achievement_orientation', 0.60],
  ],
});

/**
 * Normalizes activity signal envelopes into SignalContribution records.
 *
 * @param {string} userId
 * @param {import('./activity.signals').ActivitySignalEnvelope[]} envelopes
 * @returns {SignalContribution[]}
 */
function normalizeActivitySignals(userId, envelopes) {
  if (!Array.isArray(envelopes) || envelopes.length === 0) {
    return [];
  }

  const contributions = [];

  for (const envelope of envelopes) {
    // Proficiency weight is 0–5; normalize to [0,1]
    const proficiencyNorm = Math.min(envelope.proficiency_weight / 5.0, 1.0);
    // Leadership weight is 0–5; normalize to [0,1]
    const leadershipNorm  = Math.min(envelope.leadership_weight  / 5.0, 1.0);

    // Category-based signal contributions
    const signalMappings = ACTIVITY_CATEGORY_SIGNAL_MAP[envelope.category] ?? [];
    for (const [signalKey, baseWeight] of signalMappings) {
      const contributionWeight = parseFloat(
        Math.min(baseWeight * Math.max(proficiencyNorm, 0.20), 1.0).toFixed(4),
      );
      // Minimum floor of 0.20 * baseWeight — even a beginner-level activity contributes

      contributions.push({
        signal_key:             signalKey,
        source_type:            EVIDENCE_SOURCE_TYPES[1], // 'activity_record'
        source_domain:          'activity',
        source_reference_id:    `activity_${envelope.activity_key}`,
        source_reference_table: 'student_activities',
        contribution_weight:    contributionWeight,
        evidence_metadata: {
          activity_key:       envelope.activity_key,
          category:           envelope.category,
          proficiency_weight: envelope.proficiency_weight,
          leadership_weight:  envelope.leadership_weight,
          duration_months:    envelope.duration_months,
          weekly_frequency_hours: envelope.weekly_frequency_hours,
          currently_active:   envelope.currently_active,
          base_weight:        baseWeight,
          proficiency_norm:   proficiencyNorm,
        },
        taxonomy_version:    TAXONOMY_VERSION,
        aggregation_version: AGGREGATION_VERSION,
      });
    }

    // Cross-category leadership signal: leadership_weight > 2 adds to 'leadership' signal
    if (envelope.leadership_weight > 2 && envelope.category !== 'leadership') {
      contributions.push({
        signal_key:             'leadership',
        source_type:            EVIDENCE_SOURCE_TYPES[1], // 'activity_record'
        source_domain:          'activity',
        source_reference_id:    `activity_${envelope.activity_key}_leadership_role`,
        source_reference_table: 'student_activities',
        contribution_weight:    parseFloat((leadershipNorm * 0.70).toFixed(4)),
        evidence_metadata: {
          activity_key:      envelope.activity_key,
          category:          envelope.category,
          leadership_weight: envelope.leadership_weight,
          reason:            'cross_category_leadership_role',
        },
        taxonomy_version:    TAXONOMY_VERSION,
        aggregation_version: AGGREGATION_VERSION,
      });
    }

    // Persistence signal: from duration months (normalized against 24-month ceiling)
    if ((envelope.duration_months ?? 0) > 0) {
      const durationNorm = Math.min(envelope.duration_months / 24.0, 1.0);
      contributions.push({
        signal_key:             'persistence',
        source_type:            EVIDENCE_SOURCE_TYPES[1],
        source_domain:          'activity',
        source_reference_id:    `activity_${envelope.activity_key}_duration`,
        source_reference_table: 'student_activities',
        contribution_weight:    parseFloat(durationNorm.toFixed(4)),
        evidence_metadata: {
          activity_key:   envelope.activity_key,
          duration_months: envelope.duration_months,
          duration_norm:  durationNorm,
          reason:         'sustained_participation',
        },
        taxonomy_version:    TAXONOMY_VERSION,
        aggregation_version: AGGREGATION_VERSION,
      });
    }

    // Achievement-based contributions
    for (const achievement of envelope.achievements ?? []) {
      if (achievement.composite_weight === 0) continue;

      // Normalize composite_weight (0–9) to [0,1]
      const achievementNorm = Math.min(achievement.composite_weight / 9.0, 1.0);

      contributions.push({
        signal_key:             'achievement_orientation',
        source_type:            EVIDENCE_SOURCE_TYPES[2], // 'achievement_record'
        source_domain:          'activity',
        source_reference_id:    `activity_${envelope.activity_key}_ach_${achievement.achievement_level}`,
        source_reference_table: 'student_activity_achievements',
        contribution_weight:    parseFloat(achievementNorm.toFixed(4)),
        evidence_metadata: {
          activity_key:         envelope.activity_key,
          achievement_level:    achievement.achievement_level,
          achievement_position: achievement.achievement_position,
          achievement_year:     achievement.achievement_year,
          level_weight:         achievement.level_weight,
          position_weight:      achievement.position_weight,
          composite_weight:     achievement.composite_weight,
        },
        taxonomy_version:    TAXONOMY_VERSION,
        aggregation_version: AGGREGATION_VERSION,
      });
    }
  }

  return contributions;
}

// ─────────────────────────────────────────────────────────────────────────────
// COGNITIVE SIGNAL NORMALIZER
//
// Input: CognitiveSignalBundle (from cognitive.signals.js buildCognitiveSignalBundle)
// Output: SignalContribution[] for cognitive-domain signals
//
// The cognitive bundle already has per-domain weight vectors. This normalizer
// maps cognitive signal tags to canonical signal keys and wraps them in the
// standard SignalContribution envelope.
//
// Cognitive tag → canonical signal key mapping:
//   analytical, logic_first            → analytical_strength, structured_problem_solving
//   experimental, iterative            → exploratory_decision_making
//   structured                         → structured_problem_solving
//   intuitive, visual_first            → exploratory_decision_making
//   reading_learner, guided_learner    → structured_problem_solving
//   hands_on_learner                   → hands_on_learning
//   visual_learner                     → hands_on_learning (secondary)
//   independent_explorer               → independent_working, exploratory_decision_making
//   collaborative_learner              → collaboration
//   fast_decider, rapid_executor       → rapid_execution
//   research_heavy, certainty_seeker   → detail_orientation
//   exploratory_decider                → exploratory_decision_making
//   planner                            → structured_problem_solving, detail_orientation
//   perfection_oriented                → detail_orientation
//   adaptive_worker                    → exploratory_decision_making
//   multitask_oriented                 → rapid_execution
//   detail_focused                     → detail_orientation
//   systems_thinker                    → systems_thinking
//
// Phase 3B.4D: removed 3 stale/non-canonical source keys that were never
// members of ALL_COGNITIVE_SIGNAL_TAGS (big_picture, context_first,
// pattern_recognition — see Phase 3B.4C/3B.4C-A audits) and added the one
// approved canonical mapping for information_processing (systems_thinker).
// big_picture_oriented, sequential_thinker, and abstract_thinker remain
// deliberately unmapped per the 3B.4C-A decision review — do not add
// mappings for them without a new architecture/product decision.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps cognitive signal tags to canonical signal contributions.
 * Each entry: [signalKey, weightMultiplier].
 * Final weight = domainTagWeight * multiplier.
 */
const COGNITIVE_TAG_SIGNAL_MAP = Object.freeze({
  analytical:           [['analytical_strength', 1.00], ['structured_problem_solving', 0.60]],
  logic_first:          [['analytical_strength', 0.85], ['structured_problem_solving', 0.80]],
  experimental:         [['exploratory_decision_making', 0.85], ['hands_on_learning', 0.65]],
  iterative:            [['exploratory_decision_making', 0.70]],
  structured:           [['structured_problem_solving', 1.00]],
  intuitive:            [['exploratory_decision_making', 0.75]],
  visual_first:         [['hands_on_learning', 0.60], ['exploratory_decision_making', 0.55]],
  reading_learner:      [['analytical_strength', 0.50]],
  visual_learner:       [['hands_on_learning', 0.55]],
  hands_on_learner:     [['hands_on_learning', 1.00], ['technical_execution', 0.50]],
  guided_learner:       [['structured_problem_solving', 0.55]],
  independent_explorer: [['independent_working', 1.00], ['exploratory_decision_making', 0.60]],
  collaborative_learner:[['collaboration', 0.90]],
  fast_decider:         [['rapid_execution', 0.90]],
  research_heavy:       [['detail_orientation', 0.85], ['analytical_strength', 0.60]],
  risk_balanced:        [['entrepreneurial_signal', 0.50]],
  exploratory_decider:  [['exploratory_decision_making', 1.00]],
  certainty_seeker:     [['detail_orientation', 0.80], ['structured_problem_solving', 0.55]],
  planner:              [['structured_problem_solving', 0.85], ['detail_orientation', 0.65]],
  rapid_executor:       [['rapid_execution', 1.00]],
  perfection_oriented:  [['detail_orientation', 1.00]],
  adaptive_worker:      [['exploratory_decision_making', 0.65]],
  multitask_oriented:   [['rapid_execution', 0.70]],
  detail_focused:       [['detail_orientation', 0.90], ['analytical_strength', 0.40]],
  systems_thinker:      [['systems_thinking', 1.00]],
});

/**
 * Normalizes a cognitive signal bundle into SignalContribution records.
 *
 * @param {string} userId
 * @param {import('./cognitive.signals').CognitiveSignalBundle} bundle
 * @returns {SignalContribution[]}
 */
function normalizeCognitiveSignals(userId, bundle) {
  if (!bundle || typeof bundle !== 'object') {
    return [];
  }

  const contributions = [];

  // Iterate per-envelope (per-question response) for fine-grained evidence
  for (const envelope of bundle.envelopes ?? []) {
    for (const [tag, tagWeight] of Object.entries(envelope.aggregated_weights)) {
      if (tagWeight <= 0) continue;

      const signalMappings = COGNITIVE_TAG_SIGNAL_MAP[tag];
      if (!signalMappings) continue; // unmapped tag — no canonical signal for it

      for (const [signalKey, multiplier] of signalMappings) {
        const contributionWeight = parseFloat(
          Math.min(tagWeight * multiplier, 1.0).toFixed(4),
        );

        contributions.push({
          signal_key:             signalKey,
          source_type:            EVIDENCE_SOURCE_TYPES[0], // 'explicit_response'
          source_domain:          'cognitive',
          source_reference_id:    `question_${envelope.question_id}`,
          source_reference_table: 'student_cognitive_responses',
          contribution_weight:    contributionWeight,
          evidence_metadata: {
            question_id:          envelope.question_id,
            question_key:         envelope.question_key,
            cognitive_domain:     envelope.domain,
            selected_option_keys: envelope.selected_option_keys,
            tag,
            tag_weight:           tagWeight,
            multiplier,
          },
          taxonomy_version:    TAXONOMY_VERSION,
          aggregation_version: AGGREGATION_VERSION,
        });
      }
    }
  }

  return contributions;
}

// ─────────────────────────────────────────────────────────────────────────────
// REFLECTION SIGNAL NORMALIZER
// Handles aspiration/reflection step data.
// Adds lightweight signals when student identifies a domain of serious interest.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalizes reflection/aspiration data into SignalContribution records.
 *
 * @param {string} userId
 * @param {{
 *   favorite_activity_key:      string|null,
 *   pursue_seriously_key:       string|null,
 *   proudest_achievement_text:  string|null,
 * }} reflectionData
 * @param {Object} activityCategoryMap — { [activity_key: string]: ActivityCategory }
 * @returns {SignalContribution[]}
 */
function normalizeReflectionSignals(userId, reflectionData, activityCategoryMap = {}) {
  if (!reflectionData) return [];

  const contributions = [];

  if (reflectionData.pursue_seriously_key) {
    const category = activityCategoryMap[reflectionData.pursue_seriously_key] ?? null;
    const mappings = category ? ACTIVITY_CATEGORY_SIGNAL_MAP[category] ?? [] : [];

    for (const [signalKey] of mappings) {
      contributions.push({
        signal_key:             signalKey,
        source_type:            EVIDENCE_SOURCE_TYPES[5], // 'reflection_entry'
        source_domain:          'activity',
        source_reference_id:    `reflection_pursue_${reflectionData.pursue_seriously_key}`,
        source_reference_table: 'student_activity_reflections',
        contribution_weight:    0.60, // fixed weight: explicit intent statement
        evidence_metadata: {
          pursue_seriously_key: reflectionData.pursue_seriously_key,
          activity_category:    category,
          reason:               'stated_serious_intent',
        },
        taxonomy_version:    TAXONOMY_VERSION,
        aggregation_version: AGGREGATION_VERSION,
      });
    }
  }

  if (reflectionData.proudest_achievement_text) {
    // Existence of a proudest achievement text → persistence + achievement orientation signal
    contributions.push({
      signal_key:             'persistence',
      source_type:            EVIDENCE_SOURCE_TYPES[5],
      source_domain:          'activity',
      source_reference_id:    'reflection_proudest_achievement',
      source_reference_table: 'student_activity_reflections',
      contribution_weight:    0.40,
      evidence_metadata: {
        has_achievement_text: true,
        reason:               'stated_achievement_narrative',
      },
      taxonomy_version:    TAXONOMY_VERSION,
      aggregation_version: AGGREGATION_VERSION,
    });

    contributions.push({
      signal_key:             'achievement_orientation',
      source_type:            EVIDENCE_SOURCE_TYPES[5],
      source_domain:          'activity',
      source_reference_id:    'reflection_proudest_achievement_orientation',
      source_reference_table: 'student_activity_reflections',
      contribution_weight:    0.35,
      evidence_metadata: {
        has_achievement_text: true,
        reason:               'stated_achievement_narrative',
      },
      taxonomy_version:    TAXONOMY_VERSION,
      aggregation_version: AGGREGATION_VERSION,
    });
  }

  return contributions;
}

// ─────────────────────────────────────────────────────────────────────────────
// ASPIRATION SIGNAL NORMALIZER — Phase 3B.5B
//
// Input: the canonical, persisted student_aspirations row (as returned by
//   aspiration.repository.js#fetchAspiration()), i.e.
//   { career_interests: string[], motivation_driver: string|null,
//     time_horizon: string|null }.
// Output: SignalContribution[] for aspiration-domain signals.
//
// CONTRACT (Phase 3B.5B.0 — final, do not reopen here):
//   • Reads ONLY career_interests and motivation_driver. time_horizon is
//     intentionally never read for signal generation — it remains
//     contextual metadata only (student_aspirations.time_horizon), and
//     must never produce a signal, evidence row, or vector weight.
//   • Every selected career_interests domain produces exactly one
//     career_interest_${domain} = 1.0 signal ('undecided' produces exactly
//     career_interest_undecided = 1.0 and nothing else, by construction —
//     the validator already guarantees ['undecided'] is the only array
//     shape containing 'undecided'). Unselected domains never emit 0.0 —
//     they emit no contribution at all.
//   • A non-null motivation_driver produces exactly one
//     career_value_${driver} = 1.0 signal. A null motivation_driver
//     produces no career_value_* contribution — no default is invented.
//   • This is unrelated to, and must never be conflated with, the legacy
//     rawDomainData.aspiration.reflection / normalizeReflectionSignals()
//     activity-reflection path above — that is a different, pre-existing
//     concept keyed off student_activity_reflections, not
//     student_aspirations.
//   • Membership in CAREER_DOMAINS / MOTIVATION_DRIVERS is checked
//     defensively (mirroring the existing "unrecognized value — skip, do
//     not guess" convention used by normalizeAcademicSignals for unknown
//     subjects) — this is not new coercion logic, it is the same
//     defensive skip already established elsewhere in this file. It does
//     NOT reinterpret otherwise-valid-shaped input (e.g. a validator-
//     bypassing ['undecided', 'engineering'] array still produces both
//     career_interest_undecided and career_interest_engineering — the
//     normalizer does not silently resolve that invalid combination,
//     enforcing it is the validator's job).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalizes a student's aspiration data into SignalContribution records.
 *
 * @param {string} userId
 * @param {{
 *   career_interests:  string[],
 *   motivation_driver: string|null,
 *   time_horizon?:     string|null,
 * }} aspirationRow  — the canonical student_aspirations row.
 * @returns {SignalContribution[]}
 */
function normalizeAspirationSignals(userId, aspirationRow) {
  if (!aspirationRow || typeof aspirationRow !== 'object') {
    return [];
  }

  const contributions = [];

  // ── Career-interest signals ────────────────────────────────────────────
  const careerInterests = Array.isArray(aspirationRow.career_interests)
    ? aspirationRow.career_interests
    : [];

  for (const domain of careerInterests) {
    if (typeof domain !== 'string' || !CAREER_DOMAINS.includes(domain)) continue; // unrecognized value — skip, do not guess

    contributions.push({
      signal_key:             `career_interest_${domain}`,
      source_type:            EVIDENCE_SOURCE_TYPES[0], // 'explicit_response'
      source_domain:          'aspiration',
      source_reference_id:    `aspiration_career_interest_${domain}`,
      source_reference_table: 'student_aspirations',
      contribution_weight:    1.0,
      evidence_metadata: {
        career_domain: domain,
        reason:        'stated_career_interest',
      },
      taxonomy_version:    TAXONOMY_VERSION,
      aggregation_version: AGGREGATION_VERSION,
    });
  }

  // ── Career-value (motivation driver) signal ────────────────────────────
  const motivationDriver = aspirationRow.motivation_driver;

  if (typeof motivationDriver === 'string' && MOTIVATION_DRIVERS.includes(motivationDriver)) {
    contributions.push({
      signal_key:             `career_value_${motivationDriver}`,
      source_type:            EVIDENCE_SOURCE_TYPES[0], // 'explicit_response'
      source_domain:          'aspiration',
      source_reference_id:    `aspiration_motivation_driver_${motivationDriver}`,
      source_reference_table: 'student_aspirations',
      contribution_weight:    1.0,
      evidence_metadata: {
        motivation_driver: motivationDriver,
        reason:            'stated_career_motivation',
      },
      taxonomy_version:    TAXONOMY_VERSION,
      aggregation_version: AGGREGATION_VERSION,
    });
  }

  // time_horizon is deliberately never read above — contextual metadata
  // only, per the Phase 3B.5B.0 contract. Do not add handling for it here.

  return contributions;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  normalizeAcademicSignals,
  normalizeActivitySignals,
  normalizeCognitiveSignals,
  normalizeReflectionSignals,
  normalizeAspirationSignals,

  // Exposed for testing
  ACADEMIC_SUBJECT_SIGNAL_MAP,
  ACTIVITY_CATEGORY_SIGNAL_MAP,
  COGNITIVE_TAG_SIGNAL_MAP,

  // Legacy/superseded — kept for historical reference only, unused by
  // normalizeAcademicSignals as of Phase 3B.2. See the block comment above.
  _LEGACY_PHASE3D_ACADEMIC_BAND_WEIGHTS,
  _LEGACY_PHASE3D_SUBJECT_SIGNAL_MAP,
};
