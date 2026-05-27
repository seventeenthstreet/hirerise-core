'use strict';

/**
 * src/modules/student-onboarding/signals/cross-domain.aggregator.js
 *
 * Phase 3D — Cross-Domain Intelligence Layer
 * CROSS-DOMAIN SIGNAL AGGREGATOR
 *
 * PURPOSE:
 *   Accepts SignalContribution[] arrays from all domain normalizers and
 *   produces a fully aggregated CrossDomainSignalBundle — the canonical
 *   cross-domain intelligence output for a student at a point in time.
 *
 * CRITICAL RULES:
 *   ✗ DO NOT implement recommendations, scores, or predictions.
 *   ✗ DO NOT read from or write to the DB — pure aggregation logic.
 *   ✓ Accept SignalContribution[] from multiple domains.
 *   ✓ Apply per-signal normalization strategies (from SIGNAL_REGISTRY_METADATA).
 *   ✓ Build evidence summaries, confidence placeholders, contradiction metadata.
 *   ✓ Return a fully typed CrossDomainSignalBundle.
 *
 * AGGREGATION STRATEGIES:
 *   weighted_average — average of all contribution_weights for this signal
 *   max_pooling      — maximum contribution_weight across all evidence
 *   min_pooling      — minimum (used for rare conservative signals)
 *   evidence_count   — normalized count of evidence records (for behavioral signals)
 *
 * CONTRADICTION DETECTION:
 *   When two signals in signal_relationships with type 'contradicts' both
 *   have aggregated weight > CONTRADICTION_DETECTION_THRESHOLD, a contradiction
 *   metadata entry is added to the bundle. NO resolution — only detection.
 */

const {
  SIGNAL_REGISTRY_METADATA,
  NORMALIZATION_STRATEGIES,
  SIGNAL_WEIGHT_NOISE_FLOOR,
  CROSS_DOMAIN_REINFORCEMENT_THRESHOLD,
  CONTRADICTION_DETECTION_THRESHOLD,
  CONTRADICTION_SEVERITY,
  AGGREGATION_VERSION,
  TAXONOMY_VERSION,
  REQUIRED_DOMAINS_FOR_COMPLETE_VECTOR,
  ALL_SIGNAL_KEYS,
} = require('../constants/intelligence');

// ─────────────────────────────────────────────────────────────────────────────
// CONTRADICTION PAIRS
// Signal pairs known to potentially contradict. Loaded from constants.
// Future: load from signal_relationships DB table.
// ─────────────────────────────────────────────────────────────────────────────

const CONTRADICTION_PAIRS = Object.freeze([
  {
    signal_a:        'structured_problem_solving',
    signal_b:        'exploratory_decision_making',
    base_severity:   CONTRADICTION_SEVERITY.MODERATE,
  },
  {
    signal_a:        'rapid_execution',
    signal_b:        'detail_orientation',
    base_severity:   CONTRADICTION_SEVERITY.WEAK,
  },
]);

// ─────────────────────────────────────────────────────────────────────────────
// TYPE: CrossDomainSignalBundle
//
// @typedef {Object} CrossDomainSignalBundle
// @property {{ [signal_key: string]: number }} signal_weights
//   Aggregated signal weights, normalized [0,1]. Noise-floored.
// @property {{ academic: {...}, activity: {...}, cognitive: {...}, cross_domain: {...} }} domain_vectors
//   Per-domain view of signal contributions. Shape: { [signal_key]: number }
// @property {{ [signal_key: string]: EvidenceSummary }} evidence_summary
//   Per-signal evidence metadata summary.
// @property {{ [signal_key: string]: ConfidencePlaceholder }} confidence_data
//   Confidence placeholder structures. composite_confidence = null.
// @property {{ [pair: string]: ContradictionEntry }} contradiction_metadata
//   Detected contradictions. Empty if none. Does not resolve contradictions.
// @property {string[]} domains_included
//   Which domains contributed at least one piece of evidence.
// @property {boolean}  is_complete_vector
//   True when all REQUIRED_DOMAINS_FOR_COMPLETE_VECTOR are present.
// @property {string}   aggregation_version
// @property {string}   taxonomy_version
// @property {string}   pipeline_run_id
//
// @typedef {Object} EvidenceSummary
// @property {number}   count
// @property {string[]} domains
// @property {string}   last_updated
//
// @typedef {Object} ConfidencePlaceholder
// @property {number}  evidence_count
// @property {number}  source_diversity      [0,1] fraction of compatible domains
// @property {boolean} cross_domain_reinforcement
// @property {null}    composite_confidence  always null — placeholder only
//
// @typedef {Object} ContradictionEntry
// @property {string}  signal_a
// @property {string}  signal_b
// @property {number}  weight_a
// @property {number}  weight_b
// @property {string}  severity            contradiction_severity_enum
// @property {boolean} resolved            always false in Phase 3D
// @property {string}  detected_at
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Aggregates signal contributions from all domains into a CrossDomainSignalBundle.
 *
 * @param {string} userId
 * @param {Object} domainContributions
 * @param {import('./domain-normalizers').SignalContribution[]} domainContributions.academic
 * @param {import('./domain-normalizers').SignalContribution[]} domainContributions.activity
 * @param {import('./domain-normalizers').SignalContribution[]} domainContributions.cognitive
 * @param {string} [pipelineRunId]
 * @returns {import('./cross-domain.aggregator').CrossDomainSignalBundle}
 */
function aggregateCrossDomainSignals(userId, domainContributions, pipelineRunId = null) {
  const allContributions = [
    ...(domainContributions.academic  ?? []),
    ...(domainContributions.activity  ?? []),
    ...(domainContributions.cognitive ?? []),
  ];

  // ── Step 1: Group contributions by signal_key ─────────────────────────────
  const bySignalKey = _groupBySignalKey(allContributions);

  // ── Step 2: Apply normalization strategy per signal ───────────────────────
  const rawWeights = _applyNormalizationStrategies(bySignalKey);

  // ── Step 3: Apply noise floor — drop signals below threshold ──────────────
  const signal_weights = _applyNoiseFloor(rawWeights);

  // ── Step 4: Build per-domain vectors ──────────────────────────────────────
  const domain_vectors = _buildDomainVectors(domainContributions, signal_weights);

  // ── Step 5: Build evidence summary ────────────────────────────────────────
  const evidence_summary = _buildEvidenceSummary(bySignalKey);

  // ── Step 6: Build confidence placeholders ────────────────────────────────
  const confidence_data = _buildConfidencePlaceholders(bySignalKey, signal_weights);

  // ── Step 7: Detect contradictions ────────────────────────────────────────
  const contradiction_metadata = _detectContradictions(signal_weights);

  // ── Step 8: Determine which domains contributed ───────────────────────────
  const domains_included = _resolveDomainsIncluded(domainContributions);

  const is_complete_vector = REQUIRED_DOMAINS_FOR_COMPLETE_VECTOR.every(
    (d) => domains_included.includes(d),
  );

  return {
    signal_weights,
    domain_vectors,
    evidence_summary,
    confidence_data,
    contradiction_metadata,
    domains_included,
    is_complete_vector,
    aggregation_version: AGGREGATION_VERSION,
    taxonomy_version:    TAXONOMY_VERSION,
    pipeline_run_id:     pipelineRunId ?? `run_${Date.now()}`,
    aggregated_at:       new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Groups contributions by signal_key.
 * Returns: { [signal_key]: SignalContribution[] }
 *
 * @param {import('./domain-normalizers').SignalContribution[]} contributions
 * @returns {Record<string, import('./domain-normalizers').SignalContribution[]>}
 */
function _groupBySignalKey(contributions) {
  const grouped = {};
  for (const contribution of contributions) {
    const key = contribution.signal_key;
    if (!ALL_SIGNAL_KEYS.includes(key)) continue; // guard against unknown keys
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(contribution);
  }
  return grouped;
}

/**
 * Applies per-signal normalization strategy.
 * Returns: { [signal_key]: number }  (raw, before noise floor)
 *
 * @param {Record<string, import('./domain-normalizers').SignalContribution[]>} bySignalKey
 * @returns {Record<string, number>}
 */
function _applyNormalizationStrategies(bySignalKey) {
  const weights = {};

  for (const [signalKey, contributions] of Object.entries(bySignalKey)) {
    if (contributions.length === 0) continue;

    const meta     = SIGNAL_REGISTRY_METADATA[signalKey];
    const strategy = meta?.normalization_strategy ?? NORMALIZATION_STRATEGIES.WEIGHTED_AVERAGE;
    const values   = contributions.map((c) => c.contribution_weight);

    let weight;

    switch (strategy) {
      case NORMALIZATION_STRATEGIES.MAX_POOLING:
        weight = Math.max(...values);
        break;

      case NORMALIZATION_STRATEGIES.MIN_POOLING:
        weight = Math.min(...values);
        break;

      case NORMALIZATION_STRATEGIES.EVIDENCE_COUNT: {
        // Normalize by evidence count against a ceiling (20 records = 1.0)
        const ceiling = 20;
        weight = Math.min(contributions.length / ceiling, 1.0);
        break;
      }

      case NORMALIZATION_STRATEGIES.WEIGHTED_AVERAGE:
      default:
        weight = values.reduce((s, v) => s + v, 0) / values.length;
        break;
    }

    weights[signalKey] = parseFloat(Math.min(weight, 1.0).toFixed(4));
  }

  return weights;
}

/**
 * Removes signals below the noise floor.
 *
 * @param {Record<string, number>} rawWeights
 * @returns {Record<string, number>}
 */
function _applyNoiseFloor(rawWeights) {
  const floored = {};
  for (const [key, weight] of Object.entries(rawWeights)) {
    if (weight >= SIGNAL_WEIGHT_NOISE_FLOOR) {
      floored[key] = weight;
    }
  }
  return floored;
}

/**
 * Builds per-domain sub-vectors by re-aggregating only contributions from
 * that domain, without cross-domain merging.
 *
 * @param {Object} domainContributions
 * @param {Record<string, number>} finalWeights  — noise-floored final weights
 * @returns {{ academic: Object, activity: Object, cognitive: Object, cross_domain: Object }}
 */
function _buildDomainVectors(domainContributions, finalWeights) {
  const vectors = { academic: {}, activity: {}, cognitive: {}, cross_domain: {} };

  for (const [domainKey, contributions] of Object.entries(domainContributions)) {
    const domainName = domainKey === 'cognitive' ? 'cognitive'
                     : domainKey === 'academic'  ? 'academic'
                     : domainKey === 'activity'  ? 'activity'
                     : 'cross_domain';

    const grouped  = _groupBySignalKey(contributions ?? []);
    const rawWeights = _applyNormalizationStrategies(grouped);

    for (const [signalKey, weight] of Object.entries(rawWeights)) {
      // Only include if signal survived the global noise floor
      if (finalWeights[signalKey] !== undefined) {
        vectors[domainName][signalKey] = parseFloat(weight.toFixed(4));
      }
    }
  }

  // Cross-domain signals: signals whose primary_domain is 'cross_domain'
  // are recorded in the cross_domain vector using the global weight
  for (const [signalKey, weight] of Object.entries(finalWeights)) {
    const meta = SIGNAL_REGISTRY_METADATA[signalKey];
    if (meta?.primary_domain === 'cross_domain') {
      vectors.cross_domain[signalKey] = weight;
    }
  }

  return vectors;
}

/**
 * Builds per-signal evidence summaries.
 *
 * @param {Record<string, import('./domain-normalizers').SignalContribution[]>} bySignalKey
 * @returns {Record<string, { count: number, domains: string[], last_updated: string }>}
 */
function _buildEvidenceSummary(bySignalKey) {
  const summary = {};
  const now     = new Date().toISOString();

  for (const [signalKey, contributions] of Object.entries(bySignalKey)) {
    const domains = [...new Set(contributions.map((c) => c.source_domain))];
    summary[signalKey] = {
      count:        contributions.length,
      domains,
      last_updated: now,
    };
  }

  return summary;
}

/**
 * Builds confidence placeholder structures.
 * composite_confidence is always null in Phase 3D.
 *
 * @param {Record<string, import('./domain-normalizers').SignalContribution[]>} bySignalKey
 * @param {Record<string, number>} signal_weights
 * @returns {Record<string, ConfidencePlaceholder>}
 */
function _buildConfidencePlaceholders(bySignalKey, signal_weights) {
  const confidence = {};

  for (const [signalKey, contributions] of Object.entries(bySignalKey)) {
    if (signal_weights[signalKey] === undefined) continue; // noise-floored out

    const meta = SIGNAL_REGISTRY_METADATA[signalKey];
    const compatibleDomains = meta?.compatible_domains ?? [];
    const contributingDomains = [...new Set(contributions.map((c) => c.source_domain))];

    const sourceDiversity = compatibleDomains.length === 0 ? 0.0
      : parseFloat(
          (contributingDomains.filter((d) => compatibleDomains.includes(d)).length
            / compatibleDomains.length).toFixed(4),
        );

    const crossDomainReinforcement =
      sourceDiversity >= CROSS_DOMAIN_REINFORCEMENT_THRESHOLD &&
      contributingDomains.length >= 2;

    confidence[signalKey] = {
      evidence_count:             contributions.length,
      source_diversity:           sourceDiversity,
      cross_domain_reinforcement: crossDomainReinforcement,
      composite_confidence:       null, // placeholder — future ML pipeline
    };
  }

  return confidence;
}

/**
 * Detects contradiction pairs where both signals exceed the detection threshold.
 * Does NOT resolve contradictions.
 *
 * @param {Record<string, number>} signal_weights
 * @returns {Record<string, ContradictionEntry>}
 */
function _detectContradictions(signal_weights) {
  const contradictions = {};
  const detectedAt = new Date().toISOString();

  for (const pair of CONTRADICTION_PAIRS) {
    const weightA = signal_weights[pair.signal_a] ?? 0;
    const weightB = signal_weights[pair.signal_b] ?? 0;

    if (weightA > CONTRADICTION_DETECTION_THRESHOLD &&
        weightB > CONTRADICTION_DETECTION_THRESHOLD) {

      const pairKey = `${pair.signal_a}__${pair.signal_b}`;

      // Severity escalation: if both weights are high, escalate severity
      let severity = pair.base_severity;
      if (weightA > 0.75 && weightB > 0.75) {
        severity = CONTRADICTION_SEVERITY.STRONG;
      } else if (weightA > 0.60 && weightB > 0.60) {
        severity = CONTRADICTION_SEVERITY.MODERATE;
      }

      contradictions[pairKey] = {
        signal_a:    pair.signal_a,
        signal_b:    pair.signal_b,
        weight_a:    weightA,
        weight_b:    weightB,
        severity,
        resolved:    false,     // never resolved in Phase 3D
        detected_at: detectedAt,
      };
    }
  }

  return contradictions;
}

/**
 * Determines which domains contributed at least one evidence record.
 *
 * @param {Object} domainContributions
 * @returns {string[]}
 */
function _resolveDomainsIncluded(domainContributions) {
  return Object.entries(domainContributions)
    .filter(([, contribs]) => Array.isArray(contribs) && contribs.length > 0)
    .map(([domain]) => domain);
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  aggregateCrossDomainSignals,

  // Internal helpers exposed for unit testing
  _groupBySignalKey,
  _applyNormalizationStrategies,
  _applyNoiseFloor,
  _buildDomainVectors,
  _buildEvidenceSummary,
  _buildConfidencePlaceholders,
  _detectContradictions,
  _resolveDomainsIncluded,

  CONTRADICTION_PAIRS,
};
