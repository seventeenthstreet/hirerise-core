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
 */

const {
  EVIDENCE_SOURCE_TYPES,
  TAXONOMY_VERSION,
  AGGREGATION_VERSION,
} = require('../constants/intelligence');

// ─────────────────────────────────────────────────────────────────────────────
// ACADEMIC SIGNAL NORMALIZER
//
// Input: raw academic year rows (student_academic_years + subject snapshots)
// Output: SignalContribution[] for academic-domain signals
//
// Academic subject → signal mapping:
//   mathematics         → quantitative_reasoning (primary), analytical_strength (secondary)
//   science             → scientific_orientation (primary), analytical_strength (secondary)
//   english             → language_affinity (primary), communication_strength (secondary)
//   social_science      → social_science_interest (primary)
//   second_language     → language_affinity (secondary)
//
// Performance band → contribution weight:
//   weak      → 0.15
//   average   → 0.40
//   strong    → 0.70
//   excellent → 1.00
// ─────────────────────────────────────────────────────────────────────────────

const ACADEMIC_BAND_WEIGHTS = Object.freeze({
  weak:      0.15,
  average:   0.40,
  strong:    0.70,
  excellent: 1.00,
});

/**
 * Maps each subject to one or more signal contributions.
 * Each entry is [signal_key, weight_multiplier].
 * Weight = ACADEMIC_BAND_WEIGHTS[band] * multiplier.
 */
const SUBJECT_SIGNAL_MAP = Object.freeze({
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

/**
 * Normalizes academic year data into SignalContribution records.
 *
 * @param {string} userId
 * @param {Array<{
 *   academic_year: string,
 *   subject_snapshots: Array<{
 *     subject: string,
 *     current_band: string,
 *     previous_band: string|null,
 *   }>,
 *   is_partial: boolean,
 * }>} academicYears  — raw academic year rows with nested subject snapshots
 * @returns {SignalContribution[]}
 */
function normalizeAcademicSignals(userId, academicYears) {
  if (!Array.isArray(academicYears) || academicYears.length === 0) {
    return [];
  }

  const contributions = [];

  for (const year of academicYears) {
    if (year.is_partial) continue; // committed years only

    for (const snapshot of year.subject_snapshots ?? []) {
      const bandWeight = ACADEMIC_BAND_WEIGHTS[snapshot.current_band];
      if (bandWeight === undefined) continue; // unknown band — skip

      const signalMappings = SUBJECT_SIGNAL_MAP[snapshot.subject];
      if (!signalMappings) continue; // unmapped subject — skip

      for (const [signalKey, multiplier] of signalMappings) {
        const contributionWeight = parseFloat(
          Math.min(bandWeight * multiplier, 1.0).toFixed(4),
        );

        contributions.push({
          signal_key:             signalKey,
          source_type:            EVIDENCE_SOURCE_TYPES[3], // 'subject_performance'
          source_domain:          'academic',
          source_reference_id:    `subject_${snapshot.subject}_${year.academic_year}`,
          source_reference_table: 'student_academic_subjects',
          contribution_weight:    contributionWeight,
          evidence_metadata: {
            academic_year:   year.academic_year,
            subject:         snapshot.subject,
            current_band:    snapshot.current_band,
            previous_band:   snapshot.previous_band ?? null,
            band_weight:     bandWeight,
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
//   big_picture                        → systems_thinking
//   context_first                      → systems_thinking
//   pattern_recognition                → analytical_strength, systems_thinking
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
  big_picture:          [['systems_thinking', 1.00]],
  context_first:        [['systems_thinking', 0.85]],
  pattern_recognition:  [['analytical_strength', 0.75], ['systems_thinking', 0.70]],
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
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  normalizeAcademicSignals,
  normalizeActivitySignals,
  normalizeCognitiveSignals,
  normalizeReflectionSignals,

  // Exposed for testing
  ACADEMIC_BAND_WEIGHTS,
  SUBJECT_SIGNAL_MAP,
  ACTIVITY_CATEGORY_SIGNAL_MAP,
  COGNITIVE_TAG_SIGNAL_MAP,
};
