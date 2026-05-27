'use strict';

/**
 * signal-reliability.model.js
 *
 * Signal Reliability Engine — Phase 4A
 *
 * Evaluates the trustworthiness of each trait signal independently.
 *
 * CRITICAL CONSTRAINT:
 *   Reliability scoring MUST NOT alter raw signal values.
 *   It produces a parallel reliability dimension only.
 *   Raw scores remain unchanged; reliability is metadata about score quality.
 *
 * Reliability considers:
 *   - sample count per trait (volume adequacy)
 *   - answer consistency per trait (internal coherence)
 *   - cross-trait consistency (holistic coherence)
 *   - assessment recency (temporal freshness)
 *
 * Architecture constraints:
 *   - pure functions only
 *   - deterministic
 *   - no AI, no ML
 *   - no side effects
 */

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

const RELIABILITY_WEIGHTS = Object.freeze({
  sampleVolume:       0.35,
  answerConsistency:  0.35,
  crossConsistency:   0.20,
  recencyFactor:      0.10,
});

const RELIABILITY_LEVELS = Object.freeze({
  HIGH:        80,
  MEDIUM:      55,
  LOW:          0,
});

/** Minimum samples for each reliability band */
const SAMPLE_VOLUME_BANDS = Object.freeze({
  FULL:     7,    // → 100%
  STRONG:   5,    // → 85%
  ADEQUATE: 3,    // → 65%
  WEAK:     1,    // → 35%
  NONE:     0,    // → 0%
});

/** Days before a trait signal begins decaying in freshness */
const RECENCY_DECAY_DAYS = 90;

// ─────────────────────────────────────────────────────────────
// MAIN ENTRY POINT
// ─────────────────────────────────────────────────────────────

/**
 * Evaluates reliability for every assessed trait.
 *
 * @param {object} params
 * @param {TraitSignal[]} params.traitSignals — array of raw trait signal objects
 * @param {object}        params.crossTraitConsistencyMap — { [traitKey]: consistencyScore 0–100 }
 * @param {object}        [params.config] — optional threshold overrides
 *
 * @returns {SignalReliabilityResult}
 *
 * TraitSignal shape:
 * {
 *   traitKey:             string,
 *   rawScore:             number,       // 0–100, NOT mutated
 *   sampleCount:          number,
 *   answerConsistencyScore: number,     // 0–100 (pre-computed by normalization layer)
 *   lastAssessedAt:       string|null,  // ISO date string or null
 * }
 */
function evaluateSignalReliability({
  traitSignals              = [],
  crossTraitConsistencyMap  = {},
  config                    = {},
}) {
  const weights   = _mergeWeights(config.weights);
  const thresholds = config.thresholds ?? {};
  const now       = new Date();

  const reliabilityProfiles = traitSignals.map(signal => {
    const sampleVolumeScore      = _computeSampleVolumeScore(signal.sampleCount, config);
    const answerConsistencyScore  = _normalizeScore(signal.answerConsistencyScore);
    const crossConsistencyScore   = _normalizeScore(crossTraitConsistencyMap[signal.traitKey]);
    const recencyScore            = _computeRecencyScore(signal.lastAssessedAt, now, config);

    const reliabilityScore =
      weights.sampleVolume      * sampleVolumeScore +
      weights.answerConsistency * answerConsistencyScore +
      weights.crossConsistency  * crossConsistencyScore +
      weights.recencyFactor     * recencyScore;

    const finalScore = clamp(reliabilityScore, 0, 100);

    return {
      traitKey:          signal.traitKey,
      rawScore:          signal.rawScore,          // UNCHANGED — reliability never mutates this
      reliabilityScore:  round(finalScore),
      reliabilityLevel:  _classifyReliability(finalScore, thresholds),
      factors: {
        sampleVolume:       round(sampleVolumeScore),
        answerConsistency:  round(answerConsistencyScore),
        crossConsistency:   round(crossConsistencyScore),
        recencyFactor:      round(recencyScore),
      },
      meta: {
        sampleCount:      signal.sampleCount,
        lastAssessedAt:   signal.lastAssessedAt ?? null,
        daysSinceAssessed: _daysSince(signal.lastAssessedAt, now),
      },
    };
  });

  const summary = _buildReliabilitySummary(reliabilityProfiles);

  return {
    traitReliabilityProfiles: reliabilityProfiles,
    summary,
    meta: {
      weights,
      totalTraitsEvaluated: traitSignals.length,
      evaluatedAt: new Date().toISOString(),
      engineVersion: 'signal-reliability-v1',
    },
  };
}

// ─────────────────────────────────────────────────────────────
// FACTOR COMPUTATIONS
// ─────────────────────────────────────────────────────────────

function _computeSampleVolumeScore(sampleCount, config = {}) {
  const bands = config.sampleVolumeBands ?? SAMPLE_VOLUME_BANDS;

  if (sampleCount >= bands.FULL)     return 100;
  if (sampleCount >= bands.STRONG)   return 85;
  if (sampleCount >= bands.ADEQUATE) return 65;
  if (sampleCount >= bands.WEAK)     return 35;
  return 0;
}

function _computeRecencyScore(lastAssessedAt, now, config = {}) {
  if (!lastAssessedAt) return 50; // no date info → neutral

  const decayDays = config.recencyDecayDays ?? RECENCY_DECAY_DAYS;
  const daysSince = _daysSince(lastAssessedAt, now);

  if (daysSince === null) return 50;
  if (daysSince <= 0)     return 100;

  // Linear decay: full score within decay window, 0 at 2x decay window
  const score = Math.max(0, 100 - (daysSince / decayDays) * 100);
  return clamp(score, 0, 100);
}

// ─────────────────────────────────────────────────────────────
// SUMMARY
// ─────────────────────────────────────────────────────────────

function _buildReliabilitySummary(profiles) {
  if (!profiles.length) {
    return {
      averageReliabilityScore: 0,
      overallReliabilityLevel: 'LOW',
      highReliabilityCount:    0,
      mediumReliabilityCount:  0,
      lowReliabilityCount:     0,
      unreliableTraits:        [],
    };
  }

  const scores = profiles.map(p => p.reliabilityScore);
  const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;

  const highCount   = profiles.filter(p => p.reliabilityLevel === 'HIGH').length;
  const mediumCount = profiles.filter(p => p.reliabilityLevel === 'MEDIUM').length;
  const lowCount    = profiles.filter(p => p.reliabilityLevel === 'LOW').length;

  const unreliableTraits = profiles
    .filter(p => p.reliabilityLevel === 'LOW')
    .map(p => ({ traitKey: p.traitKey, reliabilityScore: p.reliabilityScore }));

  return {
    averageReliabilityScore: round(avgScore),
    overallReliabilityLevel: _classifyReliability(avgScore),
    highReliabilityCount:    highCount,
    mediumReliabilityCount:  mediumCount,
    lowReliabilityCount:     lowCount,
    unreliableTraits,
  };
}

// ─────────────────────────────────────────────────────────────
// CLASSIFICATION
// ─────────────────────────────────────────────────────────────

function _classifyReliability(score, thresholds = {}) {
  const high   = thresholds.HIGH   ?? RELIABILITY_LEVELS.HIGH;
  const medium = thresholds.MEDIUM ?? RELIABILITY_LEVELS.MEDIUM;

  if (score >= high)   return 'HIGH';
  if (score >= medium) return 'MEDIUM';
  return 'LOW';
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function _mergeWeights(overrides = {}) {
  return { ...RELIABILITY_WEIGHTS, ...overrides };
}

function _normalizeScore(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 50; // neutral fallback
  return clamp(num, 0, 100);
}

function _daysSince(isoDateString, now = new Date()) {
  if (!isoDateString) return null;
  try {
    const date = new Date(isoDateString);
    const diffMs = now - date;
    return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
  } catch {
    return null;
  }
}

function clamp(value, min = 0, max = 100) {
  const num = Number(value);
  if (!Number.isFinite(num)) return min;
  return Math.min(max, Math.max(min, num));
}

function round(value) {
  return parseFloat(Number(value).toFixed(2));
}

module.exports = {
  evaluateSignalReliability,
  // Exported for unit testing
  _computeSampleVolumeScore,
  _computeRecencyScore,
  _classifyReliability,
  _buildReliabilitySummary,
  RELIABILITY_WEIGHTS,
  RELIABILITY_LEVELS,
  SAMPLE_VOLUME_BANDS,
};
