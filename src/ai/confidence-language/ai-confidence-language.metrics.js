'use strict';

/**
 * @file src/ai/confidence-language/ai-confidence-language.metrics.js
 *
 * Narrative Suppression Metrics — Phase 4B Governance Hardening
 *
 * PURPOSE:
 *   Track validation rejection frequency, fallback frequency, suppression
 *   patterns, and governance quality trends. Provides aggregated metric
 *   snapshots for governance dashboards and validator tuning.
 *
 * GOVERNANCE CONSTRAINTS:
 *   ✅ Append-only — counters only increment; no mutation, no reset in production
 *   ✅ Privacy-safe — keys are capability/tier/version identifiers, never user data
 *   ✅ Analytics-isolated — metrics store has no dependency on AI, DB, or render path
 *   ✅ No content generation — pure counting layer
 *   ✅ Telemetry-decoupled — metrics are consumed by adapters, not pushed directly
 *
 * METRIC DIMENSIONS:
 *   - capability      (e.g. 'recommendation_narrative')
 *   - confidenceTier  (HIGH | MEDIUM | LOW | NO_DATA)
 *   - promptVersion   (e.g. '1.0.0')
 *   - validatorStage  (e.g. 'confidence_alignment')
 *   - failureType     (e.g. 'prohibited_phrase', 'cross_tier_escalation')
 *
 * METRIC NAMES:
 *   suppression_rate            — fraction of narratives suppressed
 *   fallback_rate               — fraction where fallback copy was used
 *   violation_rate              — fraction with any violation
 *   cross_tier_escalation_rate  — fraction with cross-tier escalation
 *   prohibited_phrase_rate      — fraction with prohibited phrase detection
 */

const { REGISTRY_VERSION } = require('./ai-confidence-language.registry');

// ─────────────────────────────────────────────────────────────────────────────
// METRIC NAMES (stable identifiers — do not rename between versions)
// ─────────────────────────────────────────────────────────────────────────────

const METRIC_NAMES = Object.freeze({
  SUPPRESSION_RATE:           'suppression_rate',
  FALLBACK_RATE:              'fallback_rate',
  VIOLATION_RATE:             'violation_rate',
  CROSS_TIER_ESCALATION_RATE: 'cross_tier_escalation_rate',
  PROHIBITED_PHRASE_RATE:     'prohibited_phrase_rate',
});

// ─────────────────────────────────────────────────────────────────────────────
// COUNTER STORE
// In-process append-only counter map.
// Keyed by dimension composite: "capability:tier:promptVersion:stage:failureType"
//
// Production deployments should flush snapshots to the persistence layer
// (ai_validation_metrics_snapshot) at configured intervals. The in-process
// store is the single source of truth for a given process lifetime.
// ─────────────────────────────────────────────────────────────────────────────

// Internal mutable store — private to module. External consumers get snapshots.
const _counters = new Map();

/**
 * Builds the composite dimension key for a metric counter entry.
 *
 * @param {Object} dims
 * @returns {string}
 */
function _dimensionKey(dims) {
  const {
    capability    = 'unknown',
    confidenceTier = 'UNKNOWN',
    promptVersion  = 'unversioned',
    validatorStage = 'unknown',
    failureType    = 'none',
  } = dims;

  return [capability, confidenceTier, promptVersion, validatorStage, failureType].join(':');
}

/**
 * Read or initialise a counter entry for a dimension composite.
 *
 * @param {string} key
 * @returns {CounterEntry}
 *
 * @typedef {Object} CounterEntry
 * @property {number} total        — total events recorded
 * @property {number} suppressed   — narratives suppressed (validation failed)
 * @property {number} fallbacks    — fallbacks rendered
 * @property {number} violations   — total violation events
 * @property {number} crossTier    — cross-tier escalation events
 * @property {number} prohibited   — prohibited phrase events
 */
function _getOrInit(key) {
  if (!_counters.has(key)) {
    _counters.set(key, {
      total:      0,
      suppressed: 0,
      fallbacks:  0,
      violations: 0,
      crossTier:  0,
      prohibited: 0,
    });
  }
  return _counters.get(key);
}

// ─────────────────────────────────────────────────────────────────────────────
// RECORD FUNCTIONS
// Called by the service layer after each validation event.
// All record functions are append-only — counters only ever increase.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record a narrative validation attempt (approved or suppressed).
 *
 * @param {Object} params
 * @param {string} params.capability
 * @param {string} params.confidenceTier
 * @param {string} params.promptVersion
 * @param {string} params.validatorStage
 * @param {boolean} params.suppressed    — true if validation failed
 * @param {boolean} params.fallbackUsed  — true if fallback copy was rendered
 */
function recordValidationAttempt({
  capability,
  confidenceTier,
  promptVersion,
  validatorStage = 'unknown',
  suppressed     = false,
  fallbackUsed   = false,
}) {
  const key   = _dimensionKey({ capability, confidenceTier, promptVersion, validatorStage, failureType: 'none' });
  const entry = _getOrInit(key);

  entry.total      += 1;
  if (suppressed)   entry.suppressed += 1;
  if (fallbackUsed) entry.fallbacks  += 1;
}

/**
 * Record a specific violation event.
 *
 * @param {Object} params
 * @param {string} params.capability
 * @param {string} params.confidenceTier
 * @param {string} params.promptVersion
 * @param {string} params.validatorStage
 * @param {string} params.failureType    — one of VIOLATION_TYPES values
 */
function recordViolation({
  capability,
  confidenceTier,
  promptVersion,
  validatorStage,
  failureType,
}) {
  // Record against the specific failure type dimension
  const specificKey   = _dimensionKey({ capability, confidenceTier, promptVersion, validatorStage, failureType });
  const specificEntry = _getOrInit(specificKey);
  specificEntry.violations += 1;

  // Classify into named counters
  if (failureType === 'cross_tier_escalation') {
    specificEntry.crossTier += 1;
  }
  if (failureType === 'prohibited_phrase') {
    specificEntry.prohibited += 1;
  }

  // Also increment on the general dimension key for rollup queries
  const rollupKey   = _dimensionKey({ capability, confidenceTier, promptVersion, validatorStage: 'unknown', failureType: 'any' });
  const rollupEntry = _getOrInit(rollupKey);
  rollupEntry.violations += 1;
}

/**
 * Record a fallback event (covers both validation-failed and ai-unavailable cases).
 *
 * @param {Object} params
 * @param {string} params.capability
 * @param {string} params.confidenceTier
 * @param {string} params.promptVersion
 * @param {string} params.reason         — e.g. 'validation_failed', 'ai_timeout'
 */
function recordFallback({
  capability,
  confidenceTier,
  promptVersion,
  reason = 'unknown',
}) {
  const key   = _dimensionKey({ capability, confidenceTier, promptVersion, validatorStage: 'fallback', failureType: reason });
  const entry = _getOrInit(key);

  entry.fallbacks += 1;
  entry.total     += 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// SNAPSHOT / REPORTING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute derived rates from raw counters for a counter entry.
 *
 * @param {CounterEntry} entry
 * @returns {Object} rates
 */
function _computeRates(entry) {
  const { total, suppressed, fallbacks, violations, crossTier, prohibited } = entry;
  const safe = total > 0 ? total : 1; // avoid division by zero

  return {
    [METRIC_NAMES.SUPPRESSION_RATE]:           _rate(suppressed,  safe),
    [METRIC_NAMES.FALLBACK_RATE]:              _rate(fallbacks,   safe),
    [METRIC_NAMES.VIOLATION_RATE]:             _rate(violations,  safe),
    [METRIC_NAMES.CROSS_TIER_ESCALATION_RATE]: _rate(crossTier,   safe),
    [METRIC_NAMES.PROHIBITED_PHRASE_RATE]:     _rate(prohibited,  safe),
  };
}

function _rate(numerator, denominator) {
  return Math.round((numerator / denominator) * 10000) / 10000; // 4 decimal places
}

/**
 * Returns an immutable snapshot of all metrics as an array of dimension+rate records.
 * Suitable for persistence to ai_validation_metrics_snapshot or governance dashboards.
 *
 * @returns {MetricsSnapshot}
 *
 * @typedef {Object} MetricsSnapshot
 * @property {string}   registryVersion
 * @property {string}   snapshotAt
 * @property {Object[]} entries
 */
function getMetricsSnapshot() {
  const entries = [];

  for (const [key, entry] of _counters.entries()) {
    const [capability, confidenceTier, promptVersion, validatorStage, failureType] = key.split(':');
    const rates = _computeRates(entry);

    entries.push(Object.freeze({
      dimensions: Object.freeze({ capability, confidenceTier, promptVersion, validatorStage, failureType }),
      counters:   Object.freeze({ ...entry }),
      rates:      Object.freeze(rates),
    }));
  }

  return Object.freeze({
    registryVersion: REGISTRY_VERSION.version,
    snapshotAt:      new Date().toISOString(),
    entries:         Object.freeze(entries),
  });
}

/**
 * Get metrics for a specific capability slice (for per-capability dashboards).
 *
 * @param {string} capability
 * @returns {MetricsSnapshot}
 */
function getCapabilityMetrics(capability) {
  const snapshot = getMetricsSnapshot();
  return Object.freeze({
    ...snapshot,
    entries: Object.freeze(
      snapshot.entries.filter((e) => e.dimensions.capability === capability)
    ),
  });
}

/**
 * Get rollup totals across all dimensions.
 * Useful for top-level governance health monitoring.
 *
 * @returns {Object}
 */
function getRollupTotals() {
  let total = 0, suppressed = 0, fallbacks = 0, violations = 0, crossTier = 0, prohibited = 0;

  for (const entry of _counters.values()) {
    total      += entry.total;
    suppressed += entry.suppressed;
    fallbacks  += entry.fallbacks;
    violations += entry.violations;
    crossTier  += entry.crossTier;
    prohibited += entry.prohibited;
  }

  const rates = _computeRates({ total, suppressed, fallbacks, violations, crossTier, prohibited });

  return Object.freeze({
    registryVersion: REGISTRY_VERSION.version,
    snapshotAt:      new Date().toISOString(),
    totals: Object.freeze({ total, suppressed, fallbacks, violations, crossTier, prohibited }),
    rates:  Object.freeze(rates),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST / DEV UTILITY
// NOT for production use. Provides a way to reset state between test runs.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resets all counters. ONLY for use in test environments.
 * Will throw if called outside test context.
 */
function _resetForTesting() {
  if (process.env.NODE_ENV !== 'test' && process.env.NODE_ENV !== 'development') {
    throw new Error('[SuppressionMetrics] _resetForTesting() called in non-test environment');
  }
  _counters.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

module.exports = Object.freeze({
  METRIC_NAMES,
  recordValidationAttempt,
  recordViolation,
  recordFallback,
  getMetricsSnapshot,
  getCapabilityMetrics,
  getRollupTotals,
  _resetForTesting,
});
