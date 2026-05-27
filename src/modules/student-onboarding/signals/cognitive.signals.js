'use strict';

/**
 * src/modules/student-onboarding/signals/cognitive.signals.js
 *
 * SIGNAL EXTRACTION INFRASTRUCTURE — Phase 3C
 *
 * ⚠️  PLACEHOLDER INFRASTRUCTURE ONLY ⚠️
 *
 * This module provides function signatures and data contracts for the
 * future intelligence engine signal extraction layer.
 *
 * CRITICAL RULES:
 *   ✗ DO NOT implement recommendation engines here.
 *   ✗ DO NOT generate career stream predictions.
 *   ✗ DO NOT infer personality traits or psychometric scores.
 *   ✗ DO NOT implement AI prediction or scoring logic.
 *
 * These functions:
 *   ✓ Normalize raw cognitive responses into engine-compatible signal envelopes.
 *   ✓ Aggregate per-domain weight vectors.
 *   ✓ Return structured, typed signal payloads with no interpretation.
 *   ✓ Are called by cognitive.service.js at commit time to populate
 *     student_cognitive_signals — NOT to feed any downstream engine yet.
 *
 * When the intelligence engine ships, it will:
 *   1. Call buildCognitiveSignalBundle() to prepare the input.
 *   2. Feed the bundle into its model.
 *   3. Write scored results back to student_cognitive_signals.engine_version
 *      and student_cognitive_signals.metadata.
 */

const {
  SIGNAL_TAG_DOMAIN_MAP,
  ALL_COGNITIVE_SIGNAL_TAGS,
  SIGNAL_WEIGHT_NOISE_FLOOR,
  COGNITIVE_DOMAINS,
} = require('../constants/cognitive');

// ─────────────────────────────────────────────────────────────────────────────
// TYPE DOCUMENTATION (JSDoc — enforced by type consumers)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} CognitiveResponseEnvelope
 * @property {string}   question_id
 * @property {string}   question_key
 * @property {string}   domain                  — cognitive_domain_enum value
 * @property {boolean}  allows_multi
 * @property {boolean}  is_required
 * @property {string[]} selected_option_keys
 * @property {{ [option_key: string]: { [signal_tag: string]: number } }} option_weights
 *   — weights map for each selected option (from cognitive_options.signal_weights)
 * @property {{ [signal_tag: string]: number }} aggregated_weights
 *   — merged weight vector across all selected options for this question
 */

/**
 * @typedef {Object} DomainSignalVector
 * @property {string}  domain
 * @property {number}  response_count       — questions answered in this domain
 * @property {{ [signal_tag: string]: number }} weights  — aggregated tag weights
 * @property {string[]} dominant_tags       — tags above SIGNAL_WEIGHT_NOISE_FLOOR
 */

/**
 * @typedef {Object} CognitiveSignalBundle
 * @property {CognitiveResponseEnvelope[]} envelopes
 * @property {{ [signal_tag: string]: number }} signal_weights  — global weighted map
 * @property {string[]}                         signal_tags     — tags above noise floor
 * @property {{ [domain: string]: DomainSignalVector }} domain_vectors
 * @property {number}                           response_count
 */

// ─────────────────────────────────────────────────────────────────────────────
// buildResponseEnvelope()
// Converts a single raw response row + its question + options into a typed
// CognitiveResponseEnvelope. Called once per response in buildCognitiveSignalBundle().
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {Object} response          — raw student_cognitive_responses row
 * @param {Object} question          — raw cognitive_questions row (with options joined)
 * @param {Object[]} questionOptions — raw cognitive_options rows for this question
 * @returns {CognitiveResponseEnvelope}
 */
function buildResponseEnvelope(response, question, questionOptions) {
  const optionWeightsMap = Object.fromEntries(
    questionOptions.map((opt) => [opt.option_key, opt.signal_weights ?? {}]),
  );

  const selectedKeys = response.selected_option_keys ?? [];

  // Aggregate signal weights across all selected options.
  // For multi-select: take the max weight per tag (not sum — prevents inflation).
  const aggregated = {};
  for (const key of selectedKeys) {
    const weights = optionWeightsMap[key] ?? {};
    for (const [tag, weight] of Object.entries(weights)) {
      aggregated[tag] = Math.max(aggregated[tag] ?? 0, Number(weight));
    }
  }

  return {
    question_id:          question.id,
    question_key:         question.question_key,
    domain:               question.domain,
    allows_multi:         question.allows_multi,
    is_required:          question.is_required,
    selected_option_keys: selectedKeys,
    option_weights:       optionWeightsMap,
    aggregated_weights:   aggregated,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// buildDomainVector()
// Aggregates all envelopes for a single domain into a DomainSignalVector.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} domain
 * @param {CognitiveResponseEnvelope[]} envelopes  — filtered to this domain
 * @returns {DomainSignalVector}
 */
function buildDomainVector(domain, envelopes) {
  if (envelopes.length === 0) {
    return {
      domain,
      response_count: 0,
      weights:        {},
      dominant_tags:  [],
    };
  }

  // Per-tag: average across questions in this domain
  const tagAccumulators = {};
  const tagCounts       = {};

  for (const envelope of envelopes) {
    for (const [tag, weight] of Object.entries(envelope.aggregated_weights)) {
      tagAccumulators[tag] = (tagAccumulators[tag] ?? 0) + Number(weight);
      tagCounts[tag]       = (tagCounts[tag] ?? 0) + 1;
    }
  }

  const weights = {};
  for (const tag of Object.keys(tagAccumulators)) {
    weights[tag] = parseFloat(
      (tagAccumulators[tag] / tagCounts[tag]).toFixed(4),
    );
  }

  const dominant_tags = Object.entries(weights)
    .filter(([, w]) => w >= SIGNAL_WEIGHT_NOISE_FLOOR)
    .sort(([, a], [, b]) => b - a)
    .map(([tag]) => tag);

  return {
    domain,
    response_count: envelopes.length,
    weights,
    dominant_tags,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// buildCognitiveSignalBundle()
// Top-level entry point. Aggregates all student responses into a
// CognitiveSignalBundle ready to write to student_cognitive_signals.
//
// @param {Object[]} responses       — raw student_cognitive_responses rows
// @param {Object[]} taxonomyRows    — result of fetchCognitiveTaxonomy()
//   (already contains nested questions + options)
// @returns {CognitiveSignalBundle}
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {Object[]} responses
 * @param {Object[]} taxonomyRows
 * @returns {CognitiveSignalBundle}
 */
function buildCognitiveSignalBundle(responses, taxonomyRows) {
  // Build lookup maps for O(1) access
  const questionMap = {};  // question_id → { ...question, domain }
  const optionsMap  = {};  // question_id → Option[]

  for (const taxonomy of taxonomyRows) {
    for (const question of taxonomy.cognitive_questions ?? []) {
      questionMap[question.id] = { ...question, domain: taxonomy.domain };
      optionsMap[question.id]  = question.cognitive_options ?? [];
    }
  }

  // Build per-response envelopes
  const envelopes = [];
  for (const response of responses) {
    const question = questionMap[response.question_id];
    if (!question) continue;  // question inactive or deleted — skip gracefully
    const options = optionsMap[response.question_id] ?? [];
    envelopes.push(buildResponseEnvelope(response, question, options));
  }

  // Build domain vectors
  const domain_vectors = {};
  for (const domain of COGNITIVE_DOMAINS) {
    const domainEnvelopes = envelopes.filter((e) => e.domain === domain);
    domain_vectors[domain] = buildDomainVector(domain, domainEnvelopes);
  }

  // Build global signal_weights: average of all domain weights per tag
  const globalAccumulators = {};
  const globalCounts       = {};
  for (const envelope of envelopes) {
    for (const [tag, weight] of Object.entries(envelope.aggregated_weights)) {
      globalAccumulators[tag] = (globalAccumulators[tag] ?? 0) + Number(weight);
      globalCounts[tag]       = (globalCounts[tag] ?? 0) + 1;
    }
  }

  const signal_weights = {};
  for (const tag of Object.keys(globalAccumulators)) {
    signal_weights[tag] = parseFloat(
      (globalAccumulators[tag] / globalCounts[tag]).toFixed(4),
    );
  }

  // Derive signal_tags: tags above noise floor, sorted descending by weight
  const signal_tags = Object.entries(signal_weights)
    .filter(([, w]) => w >= SIGNAL_WEIGHT_NOISE_FLOOR)
    .sort(([, a], [, b]) => b - a)
    .map(([tag]) => tag);

  return {
    envelopes,
    signal_weights,
    signal_tags,
    domain_vectors,
    response_count: responses.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Domain-specific signal extractors
// FUTURE: intelligence engine will call these for targeted domain analysis.
// Each returns the DomainSignalVector for its domain from a pre-built bundle.
// ─────────────────────────────────────────────────────────────────────────────

/** @param {CognitiveSignalBundle} bundle */
function extractProblemSolvingSignals(bundle) {
  return bundle.domain_vectors['problem_solving'] ?? buildDomainVector('problem_solving', []);
}

/** @param {CognitiveSignalBundle} bundle */
function extractLearningSignals(bundle) {
  return bundle.domain_vectors['learning_preference'] ?? buildDomainVector('learning_preference', []);
}

/** @param {CognitiveSignalBundle} bundle */
function extractDecisionSignals(bundle) {
  return bundle.domain_vectors['decision_making'] ?? buildDomainVector('decision_making', []);
}

/** @param {CognitiveSignalBundle} bundle */
function extractExecutionSignals(bundle) {
  return bundle.domain_vectors['execution_pattern'] ?? buildDomainVector('execution_pattern', []);
}

/** @param {CognitiveSignalBundle} bundle */
function extractInformationProcessingSignals(bundle) {
  return bundle.domain_vectors['information_processing'] ?? buildDomainVector('information_processing', []);
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  buildResponseEnvelope,
  buildDomainVector,
  buildCognitiveSignalBundle,
  extractProblemSolvingSignals,
  extractLearningSignals,
  extractDecisionSignals,
  extractExecutionSignals,
  extractInformationProcessingSignals,
};
