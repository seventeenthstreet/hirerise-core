'use strict';

/**
 * src/modules/student-onboarding/constants/intelligence.js
 *
 * Phase 3D — Cross-Domain Intelligence Layer
 * SINGLE SOURCE OF TRUTH for all intelligence signal constants.
 *
 * RULES:
 *  - All signal keys here MUST mirror intelligence_signal_registry seed data.
 *  - All domain/category values MUST mirror SQL enum definitions.
 *  - Never hardcode signal keys in services, aggregators, or validators.
 *  - DO NOT add scoring logic, recommendation weights, or prediction outputs.
 *  - Deprecate signals by adding to DEPRECATED_SIGNAL_KEYS — never delete.
 */

// ─────────────────────────────────────────────────────────────────────────────
// INTELLIGENCE DOMAINS
// Mirror of: intelligence_domain_enum in migration
// ─────────────────────────────────────────────────────────────────────────────

const INTELLIGENCE_DOMAINS = Object.freeze([
  'academic',
  'activity',
  'cognitive',
  'cross_domain',
]);

// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL CATEGORIES
// Mirror of: signal_category_enum in migration
// ─────────────────────────────────────────────────────────────────────────────

const SIGNAL_CATEGORIES = Object.freeze([
  'reasoning',
  'creative',
  'social',
  'technical',
  'cognitive_style',
  'subject_affinity',
  'behavioral',
  'meta',
]);

// ─────────────────────────────────────────────────────────────────────────────
// EVIDENCE SOURCE TYPES
// Mirror of: evidence_source_enum in migration
// ─────────────────────────────────────────────────────────────────────────────

const EVIDENCE_SOURCE_TYPES = Object.freeze([
  'explicit_response',
  'activity_record',
  'achievement_record',
  'subject_performance',
  'cross_domain_merge',
  'reflection_entry',
]);

// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL RELATIONSHIP TYPES
// Mirror of: signal_relationship_type_enum in migration
// ─────────────────────────────────────────────────────────────────────────────

const SIGNAL_RELATIONSHIP_TYPES = Object.freeze([
  'reinforces',
  'contradicts',
  'subsumes',
  'correlates',
]);

// ─────────────────────────────────────────────────────────────────────────────
// CONTRADICTION SEVERITY LEVELS
// Mirror of: contradiction_severity_enum in migration
// ─────────────────────────────────────────────────────────────────────────────

const CONTRADICTION_SEVERITY = Object.freeze({
  NONE:     'none',
  WEAK:     'weak',
  MODERATE: 'moderate',
  STRONG:   'strong',
});

// ─────────────────────────────────────────────────────────────────────────────
// NORMALIZATION STRATEGIES
// Mirror of: chk_normalization_strategy CHECK constraint in migration
// ─────────────────────────────────────────────────────────────────────────────

const NORMALIZATION_STRATEGIES = Object.freeze({
  WEIGHTED_AVERAGE: 'weighted_average',
  MAX_POOLING:      'max_pooling',
  MIN_POOLING:      'min_pooling',
  EVIDENCE_COUNT:   'evidence_count',
});

// ─────────────────────────────────────────────────────────────────────────────
// CANONICAL SIGNAL KEYS
// These are the ONLY valid signal_key values in the v1 taxonomy.
// Grouped by primary domain for readability.
//
// ADDING A SIGNAL:
//   1. Add to the appropriate group below.
//   2. Add to SIGNAL_REGISTRY_METADATA below.
//   3. Add a migration entry to intelligence_signal_registry seed.
//   4. Update signal_relationships if applicable.
//
// DEPRECATING A SIGNAL:
//   1. Move the key to DEPRECATED_SIGNAL_KEYS below.
//   2. Add `deprecated_at` in a migration UPDATE.
//   3. Do NOT delete from this file — evidence records reference by key.
// ─────────────────────────────────────────────────────────────────────────────

// Academic domain signals
const ACADEMIC_SIGNAL_KEYS = Object.freeze([
  'analytical_strength',
  'quantitative_reasoning',
  'language_affinity',
  'scientific_orientation',
  'social_science_interest',
]);

// Activity domain signals
const ACTIVITY_SIGNAL_KEYS = Object.freeze([
  'leadership',
  'technical_execution',
  'creative_expression',
  'collaboration',
  'persistence',
  'achievement_orientation',
]);

// Cognitive domain signals
const COGNITIVE_SIGNAL_KEYS = Object.freeze([
  'systems_thinking',
  'hands_on_learning',
  'structured_problem_solving',
  'exploratory_decision_making',
  'detail_orientation',
  'independent_working',
  'rapid_execution',
]);

// Cross-domain aggregated signals
const CROSS_DOMAIN_SIGNAL_KEYS = Object.freeze([
  'stem_affinity',
  'communication_strength',
  'entrepreneurial_signal',
]);

// All signal keys — used for registry validation
const ALL_SIGNAL_KEYS = Object.freeze([
  ...ACADEMIC_SIGNAL_KEYS,
  ...ACTIVITY_SIGNAL_KEYS,
  ...COGNITIVE_SIGNAL_KEYS,
  ...CROSS_DOMAIN_SIGNAL_KEYS,
]);

// Deprecated signal keys — no new evidence should be written for these
const DEPRECATED_SIGNAL_KEYS = Object.freeze([]);

// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL REGISTRY METADATA
// Mirrors intelligence_signal_registry seed data.
// Used by aggregators and validators without DB round-trips.
//
// NOTE: This is a LOCAL CACHE of the registry for runtime use.
//       Authoritative values live in the DB.
//       When registry changes, update BOTH here AND the migration.
// ─────────────────────────────────────────────────────────────────────────────

const SIGNAL_REGISTRY_METADATA = Object.freeze({

  // ── Academic signals ────────────────────────────────────────────────────────

  analytical_strength: {
    category:               'reasoning',
    primary_domain:         'academic',
    compatible_domains:     ['academic', 'cognitive'],
    normalization_strategy: 'weighted_average',
    aggregation_compatible: true,
    longitudinal_trackable: true,
  },
  quantitative_reasoning: {
    category:               'reasoning',
    primary_domain:         'academic',
    compatible_domains:     ['academic', 'cognitive'],
    normalization_strategy: 'weighted_average',
    aggregation_compatible: true,
    longitudinal_trackable: true,
  },
  language_affinity: {
    category:               'subject_affinity',
    primary_domain:         'academic',
    compatible_domains:     ['academic'],
    normalization_strategy: 'weighted_average',
    aggregation_compatible: true,
    longitudinal_trackable: true,
  },
  scientific_orientation: {
    category:               'subject_affinity',
    primary_domain:         'academic',
    compatible_domains:     ['academic', 'activity'],
    normalization_strategy: 'weighted_average',
    aggregation_compatible: true,
    longitudinal_trackable: true,
  },
  social_science_interest: {
    category:               'subject_affinity',
    primary_domain:         'academic',
    compatible_domains:     ['academic', 'cognitive'],
    normalization_strategy: 'weighted_average',
    aggregation_compatible: true,
    longitudinal_trackable: true,
  },

  // ── Activity signals ────────────────────────────────────────────────────────

  leadership: {
    category:               'social',
    primary_domain:         'activity',
    compatible_domains:     ['activity', 'cognitive'],
    normalization_strategy: 'max_pooling',
    aggregation_compatible: true,
    longitudinal_trackable: true,
  },
  technical_execution: {
    category:               'technical',
    primary_domain:         'activity',
    compatible_domains:     ['activity', 'academic', 'cognitive'],
    normalization_strategy: 'weighted_average',
    aggregation_compatible: true,
    longitudinal_trackable: true,
  },
  creative_expression: {
    category:               'creative',
    primary_domain:         'activity',
    compatible_domains:     ['activity', 'cognitive'],
    normalization_strategy: 'max_pooling',
    aggregation_compatible: true,
    longitudinal_trackable: true,
  },
  collaboration: {
    category:               'social',
    primary_domain:         'activity',
    compatible_domains:     ['activity', 'cognitive'],
    normalization_strategy: 'weighted_average',
    aggregation_compatible: true,
    longitudinal_trackable: true,
  },
  persistence: {
    category:               'behavioral',
    primary_domain:         'activity',
    compatible_domains:     ['activity', 'cognitive'],
    normalization_strategy: 'weighted_average',
    aggregation_compatible: true,
    longitudinal_trackable: true,
  },
  achievement_orientation: {
    category:               'behavioral',
    primary_domain:         'activity',
    compatible_domains:     ['activity'],
    normalization_strategy: 'max_pooling',
    aggregation_compatible: true,
    longitudinal_trackable: true,
  },

  // ── Cognitive signals ───────────────────────────────────────────────────────

  systems_thinking: {
    category:               'reasoning',
    primary_domain:         'cognitive',
    compatible_domains:     ['cognitive', 'academic', 'activity'],
    normalization_strategy: 'weighted_average',
    aggregation_compatible: true,
    longitudinal_trackable: true,
  },
  hands_on_learning: {
    category:               'cognitive_style',
    primary_domain:         'cognitive',
    compatible_domains:     ['cognitive', 'activity'],
    normalization_strategy: 'weighted_average',
    aggregation_compatible: true,
    longitudinal_trackable: true,
  },
  structured_problem_solving: {
    category:               'reasoning',
    primary_domain:         'cognitive',
    compatible_domains:     ['cognitive', 'academic'],
    normalization_strategy: 'weighted_average',
    aggregation_compatible: true,
    longitudinal_trackable: true,
  },
  exploratory_decision_making: {
    category:               'cognitive_style',
    primary_domain:         'cognitive',
    compatible_domains:     ['cognitive'],
    normalization_strategy: 'weighted_average',
    aggregation_compatible: true,
    longitudinal_trackable: true,
  },
  detail_orientation: {
    category:               'cognitive_style',
    primary_domain:         'cognitive',
    compatible_domains:     ['cognitive', 'academic'],
    normalization_strategy: 'weighted_average',
    aggregation_compatible: true,
    longitudinal_trackable: true,
  },
  independent_working: {
    category:               'cognitive_style',
    primary_domain:         'cognitive',
    compatible_domains:     ['cognitive', 'activity'],
    normalization_strategy: 'weighted_average',
    aggregation_compatible: true,
    longitudinal_trackable: true,
  },
  rapid_execution: {
    category:               'behavioral',
    primary_domain:         'cognitive',
    compatible_domains:     ['cognitive', 'activity'],
    normalization_strategy: 'weighted_average',
    aggregation_compatible: true,
    longitudinal_trackable: true,
  },

  // ── Cross-domain signals ────────────────────────────────────────────────────

  stem_affinity: {
    category:               'subject_affinity',
    primary_domain:         'cross_domain',
    compatible_domains:     ['academic', 'activity', 'cognitive'],
    normalization_strategy: 'weighted_average',
    aggregation_compatible: true,
    longitudinal_trackable: true,
  },
  communication_strength: {
    category:               'social',
    primary_domain:         'cross_domain',
    compatible_domains:     ['academic', 'activity', 'cognitive'],
    normalization_strategy: 'weighted_average',
    aggregation_compatible: true,
    longitudinal_trackable: true,
  },
  entrepreneurial_signal: {
    category:               'behavioral',
    primary_domain:         'cross_domain',
    compatible_domains:     ['activity', 'cognitive'],
    normalization_strategy: 'weighted_average',
    aggregation_compatible: true,
    longitudinal_trackable: true,
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// AGGREGATION CONFIGURATION
// Pipeline-level constants consumed by the aggregation service.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimum evidence records required for a signal to appear in student_signal_vectors.
 * Signals with fewer evidence records are dropped from the vector (not set to zero).
 */
const MIN_EVIDENCE_FOR_SIGNAL = 1;

/**
 * Weight noise floor — signals with final weight below this are excluded from
 * the aggregated vector. Prevents near-zero noise signals.
 */
const SIGNAL_WEIGHT_NOISE_FLOOR = 0.10;

/**
 * Source diversity threshold — minimum fraction of compatible domains
 * that must contribute for cross_domain_reinforcement to be flagged true.
 */
const CROSS_DOMAIN_REINFORCEMENT_THRESHOLD = 0.50;

/**
 * Contradiction detection threshold — when two signals marked 'contradicts'
 * both have weight above this value, contradiction metadata is written.
 */
const CONTRADICTION_DETECTION_THRESHOLD = 0.50;

/**
 * Aggregation version identifier. Bump to invalidate and regenerate all vectors.
 */
const AGGREGATION_VERSION = 'v1';

/**
 * Taxonomy version identifier. Must match intelligence_signal_registry.taxonomy_version.
 */
const TAXONOMY_VERSION = 'v1';

/**
 * Required intelligence domains for a vector to be flagged is_complete_vector.
 * Order is not significant.
 */
const REQUIRED_DOMAINS_FOR_COMPLETE_VECTOR = Object.freeze([
  'academic',
  'activity',
  'cognitive',
]);

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  // Enums
  INTELLIGENCE_DOMAINS,
  SIGNAL_CATEGORIES,
  EVIDENCE_SOURCE_TYPES,
  SIGNAL_RELATIONSHIP_TYPES,
  CONTRADICTION_SEVERITY,
  NORMALIZATION_STRATEGIES,

  // Signal key sets
  ACADEMIC_SIGNAL_KEYS,
  ACTIVITY_SIGNAL_KEYS,
  COGNITIVE_SIGNAL_KEYS,
  CROSS_DOMAIN_SIGNAL_KEYS,
  ALL_SIGNAL_KEYS,
  DEPRECATED_SIGNAL_KEYS,

  // Registry metadata cache
  SIGNAL_REGISTRY_METADATA,

  // Aggregation configuration
  MIN_EVIDENCE_FOR_SIGNAL,
  SIGNAL_WEIGHT_NOISE_FLOOR,
  CROSS_DOMAIN_REINFORCEMENT_THRESHOLD,
  CONTRADICTION_DETECTION_THRESHOLD,
  AGGREGATION_VERSION,
  TAXONOMY_VERSION,
  REQUIRED_DOMAINS_FOR_COMPLETE_VECTOR,
};
