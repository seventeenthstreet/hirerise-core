'use strict';

/**
 * src/modules/student-onboarding/constants/cognitive.js
 *
 * Phase 3C — Cognitive & Processing Intelligence
 * Single source of truth for all cognitive-domain enum values,
 * signal tag definitions, weights, and collection thresholds.
 *
 * RULES:
 *  - All enum values must mirror the SQL migration enums and CHECK constraints.
 *  - Never hardcode these strings in routes, services, or validators.
 *  - Add values here first, then update the SQL migration.
 *  - Do not remove values; comment-deprecate instead.
 */

// ─────────────────────────────────────────────────────────────────────────────
// COGNITIVE DOMAINS
// Mirror of: cognitive_domain_enum in migration
// ─────────────────────────────────────────────────────────────────────────────

const COGNITIVE_DOMAINS = Object.freeze([
  'problem_solving',
  'learning_preference',
  'decision_making',
  'execution_pattern',
  'information_processing',
]);

const COGNITIVE_DOMAIN_LABELS = Object.freeze({
  problem_solving:       'Problem-Solving Style',
  learning_preference:   'Learning Style',
  decision_making:       'Decision-Making Style',
  execution_pattern:     'Work & Execution Style',
  information_processing:'Information Processing',
});

// ─────────────────────────────────────────────────────────────────────────────
// COGNITIVE SIGNAL TAGS
// Mirror of: cognitive_signal_tag_enum in migration
// Grouped by domain for readability. All are valid globally.
// ─────────────────────────────────────────────────────────────────────────────

const PROBLEM_SOLVING_TAGS = Object.freeze([
  'analytical',
  'experimental',
  'structured',
  'intuitive',
  'iterative',
  'visual_first',
  'logic_first',
]);

const LEARNING_PREFERENCE_TAGS = Object.freeze([
  'reading_learner',
  'visual_learner',
  'hands_on_learner',
  'guided_learner',
  'independent_explorer',
  'collaborative_learner',
]);

const DECISION_MAKING_TAGS = Object.freeze([
  'fast_decider',
  'research_heavy',
  'risk_balanced',
  'exploratory_decider',
  'certainty_seeker',
]);

const EXECUTION_PATTERN_TAGS = Object.freeze([
  'planner',
  'rapid_executor',
  'perfection_oriented',
  'adaptive_worker',
  'multitask_oriented',
]);

const INFORMATION_PROCESSING_TAGS = Object.freeze([
  'detail_focused',
  'big_picture_oriented',
  'systems_thinker',
  'sequential_thinker',
  'abstract_thinker',
]);

const ALL_COGNITIVE_SIGNAL_TAGS = Object.freeze([
  ...PROBLEM_SOLVING_TAGS,
  ...LEARNING_PREFERENCE_TAGS,
  ...DECISION_MAKING_TAGS,
  ...EXECUTION_PATTERN_TAGS,
  ...INFORMATION_PROCESSING_TAGS,
]);

// Map: tag → owning domain (for vector building in signal extraction)
const SIGNAL_TAG_DOMAIN_MAP = Object.freeze(
  Object.fromEntries([
    ...PROBLEM_SOLVING_TAGS.map((t)      => [t, 'problem_solving']),
    ...LEARNING_PREFERENCE_TAGS.map((t)  => [t, 'learning_preference']),
    ...DECISION_MAKING_TAGS.map((t)      => [t, 'decision_making']),
    ...EXECUTION_PATTERN_TAGS.map((t)    => [t, 'execution_pattern']),
    ...INFORMATION_PROCESSING_TAGS.map((t) => [t, 'information_processing']),
  ]),
);

// ─────────────────────────────────────────────────────────────────────────────
// COLLECTION THRESHOLDS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimum required responses to consider the cognitive step committable.
 * Must answer all required questions (see is_required in cognitive_questions).
 */
const MIN_REQUIRED_RESPONSES_FOR_COMMIT = 5;

/**
 * Maximum allowed responses per student (one per question;
 * enforced via UNIQUE constraint, but checked here for validator clarity).
 */
const MAX_COGNITIVE_QUESTIONS = 10;

/**
 * Maximum number of option_keys allowed in a multi-select response.
 */
const MAX_MULTI_SELECT_CHOICES = 3;

/**
 * Signal weight clamping bounds.
 * Weights stored in cognitive_options.signal_weights must be in [0.0, 1.0].
 */
const SIGNAL_WEIGHT_MIN = 0.0;
const SIGNAL_WEIGHT_MAX = 1.0;

/**
 * Signal weight threshold below which a tag is considered noise and
 * excluded from student_cognitive_signals.signal_tags[].
 * FUTURE: intelligence engine will refine this threshold.
 */
const SIGNAL_WEIGHT_NOISE_FLOOR = 0.3;

// ─────────────────────────────────────────────────────────────────────────────
// QUESTION KEYS
// Mirror of: question_key values seeded in migration.
// Used in validators and signal extraction to reference questions by stable key.
// ─────────────────────────────────────────────────────────────────────────────

const COGNITIVE_QUESTION_KEYS = Object.freeze([
  'learn_new_skill',
  'hard_problem_approach',
  'learning_context_preference',
  'decide_under_uncertainty',
  'starting_big_task',
  'understanding_new_topic',
  'handling_setback',
  'reviewing_own_work',
  'exploring_new_interest',
  'processing_feedback',
]);

/**
 * Required question keys (is_required = true in migration).
 * Committing the step requires all of these to be answered.
 */
const REQUIRED_QUESTION_KEYS = Object.freeze([
  'learn_new_skill',
  'hard_problem_approach',
  'decide_under_uncertainty',
  'starting_big_task',
  'understanding_new_topic',
]);

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  COGNITIVE_DOMAINS,
  COGNITIVE_DOMAIN_LABELS,

  PROBLEM_SOLVING_TAGS,
  LEARNING_PREFERENCE_TAGS,
  DECISION_MAKING_TAGS,
  EXECUTION_PATTERN_TAGS,
  INFORMATION_PROCESSING_TAGS,
  ALL_COGNITIVE_SIGNAL_TAGS,
  SIGNAL_TAG_DOMAIN_MAP,

  MIN_REQUIRED_RESPONSES_FOR_COMMIT,
  MAX_COGNITIVE_QUESTIONS,
  MAX_MULTI_SELECT_CHOICES,
  SIGNAL_WEIGHT_MIN,
  SIGNAL_WEIGHT_MAX,
  SIGNAL_WEIGHT_NOISE_FLOOR,

  COGNITIVE_QUESTION_KEYS,
  REQUIRED_QUESTION_KEYS,
};
