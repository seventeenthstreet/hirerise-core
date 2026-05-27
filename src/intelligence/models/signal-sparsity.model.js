'use strict';

/**
 * signal-sparsity.model.js
 *
 * Signal Sparsity Safeguards — Phase 4A
 *
 * Prevents misleading recommendations when assessment quality is insufficient.
 *
 * Safeguard rules:
 *   - sparsity detection
 *   - recommendation suppression gates
 *   - low-confidence handling
 *   - explainability-safe warnings
 *
 * This model is read-only with respect to scores.
 * It does NOT modify any scores — it gates and annotates.
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

const SPARSITY_THRESHOLDS = Object.freeze({
  /** Coverage below this → SPARSE, recommendations suppressed */
  SUPPRESSION_COVERAGE_GATE: 40,
  /** Reliability below this → LOW_RELIABILITY warning */
  LOW_RELIABILITY_GATE:      45,
  /** Contradictions per 10 questions above this → WARNING */
  CONTRADICTION_RATE_GATE:   0.25,
  /** Abandonment rate above this → INCOMPLETE warning */
  ABANDONMENT_RATE_GATE:     0.30,
  /** Min traits for safe recommendation */
  MIN_TRAITS_FOR_RECOMMENDATION: 3,
});

const SUPPRESSION_REASONS = Object.freeze({
  LOW_COVERAGE:           'LOW_COVERAGE',
  LOW_RELIABILITY:        'LOW_RELIABILITY',
  INSUFFICIENT_TRAITS:    'INSUFFICIENT_TRAITS',
  HIGH_CONTRADICTION_RATE: 'HIGH_CONTRADICTION_RATE',
  HIGH_ABANDONMENT_RATE:  'HIGH_ABANDONMENT_RATE',
});

// ─────────────────────────────────────────────────────────────
// MAIN ENTRY POINT
// ─────────────────────────────────────────────────────────────

/**
 * Evaluates whether signal sparsity warrants recommendation suppression
 * and generates explainability-safe warnings.
 *
 * @param {object} params
 * @param {number}   params.coverageScore         — from signal-coverage.model
 * @param {string}   params.coverageLevel         — 'HIGH' | 'MEDIUM' | 'LOW'
 * @param {number}   params.averageReliabilityScore
 * @param {number}   params.evaluatedTraitCount
 * @param {number}   params.contradictoryAnswers
 * @param {number}   params.totalQuestionsAnswered
 * @param {number}   params.completedStages
 * @param {number}   params.totalStages
 * @param {object}   [params.config]              — optional threshold overrides
 *
 * @returns {SparsityEvaluationResult}
 */
function evaluateSignalSparsity({
  coverageScore              = 0,
  coverageLevel              = 'LOW',
  averageReliabilityScore    = 0,
  evaluatedTraitCount        = 0,
  contradictoryAnswers       = 0,
  totalQuestionsAnswered     = 0,
  completedStages            = 0,
  totalStages                = 1,
  config                     = {},
}) {
  const thresholds = _mergeThresholds(config.thresholds);

  const suppressionFlags  = [];
  const warningFlags      = [];

  // ── Gate 1: Coverage ────────────────────────────────────────
  if (coverageScore < thresholds.SUPPRESSION_COVERAGE_GATE) {
    suppressionFlags.push({
      reason:  SUPPRESSION_REASONS.LOW_COVERAGE,
      detail:  `Coverage score ${coverageScore.toFixed(1)}% is below the minimum threshold of ${thresholds.SUPPRESSION_COVERAGE_GATE}%`,
      severity: 'CRITICAL',
    });
  }

  // ── Gate 2: Reliability ─────────────────────────────────────
  if (averageReliabilityScore < thresholds.LOW_RELIABILITY_GATE) {
    suppressionFlags.push({
      reason:  SUPPRESSION_REASONS.LOW_RELIABILITY,
      detail:  `Average signal reliability ${averageReliabilityScore.toFixed(1)}% is below safe threshold of ${thresholds.LOW_RELIABILITY_GATE}%`,
      severity: 'HIGH',
    });
  }

  // ── Gate 3: Trait minimum ───────────────────────────────────
  if (evaluatedTraitCount < thresholds.MIN_TRAITS_FOR_RECOMMENDATION) {
    suppressionFlags.push({
      reason:  SUPPRESSION_REASONS.INSUFFICIENT_TRAITS,
      detail:  `Only ${evaluatedTraitCount} trait(s) evaluated; minimum ${thresholds.MIN_TRAITS_FOR_RECOMMENDATION} required for recommendations`,
      severity: 'CRITICAL',
    });
  }

  // ── Warning: Contradiction rate ─────────────────────────────
  const contradictionRate = totalQuestionsAnswered > 0
    ? contradictoryAnswers / totalQuestionsAnswered
    : 0;

  if (contradictionRate > thresholds.CONTRADICTION_RATE_GATE) {
    warningFlags.push({
      reason:  SUPPRESSION_REASONS.HIGH_CONTRADICTION_RATE,
      detail:  `${(contradictionRate * 100).toFixed(1)}% contradictory answer rate detected (threshold: ${(thresholds.CONTRADICTION_RATE_GATE * 100).toFixed(0)}%)`,
      severity: 'MEDIUM',
    });
  }

  // ── Warning: Abandonment rate ───────────────────────────────
  const abandonmentRate = totalStages > 0
    ? (totalStages - completedStages) / totalStages
    : 0;

  if (abandonmentRate > thresholds.ABANDONMENT_RATE_GATE) {
    warningFlags.push({
      reason:  SUPPRESSION_REASONS.HIGH_ABANDONMENT_RATE,
      detail:  `${(abandonmentRate * 100).toFixed(1)}% of assessment stages incomplete (threshold: ${(thresholds.ABANDONMENT_RATE_GATE * 100).toFixed(0)}%)`,
      severity: 'MEDIUM',
    });
  }

  const suppressRecommendations = suppressionFlags.length > 0;
  const sparsityLevel           = _computeSparsityLevel(suppressionFlags, warningFlags);

  return {
    suppressRecommendations,
    sparsityLevel,
    suppressionFlags,
    warningFlags,
    userFacingWarning: _buildUserFacingWarning(suppressRecommendations, sparsityLevel, suppressionFlags, warningFlags),
    meta: {
      coverageScore,
      coverageLevel,
      averageReliabilityScore,
      evaluatedTraitCount,
      contradictionRate: parseFloat(contradictionRate.toFixed(3)),
      abandonmentRate:   parseFloat(abandonmentRate.toFixed(3)),
      thresholds,
      engineVersion: 'signal-sparsity-v1',
    },
  };
}

// ─────────────────────────────────────────────────────────────
// SPARSITY LEVEL CLASSIFICATION
// ─────────────────────────────────────────────────────────────

function _computeSparsityLevel(suppressionFlags, warningFlags) {
  const criticalCount = suppressionFlags.filter(f => f.severity === 'CRITICAL').length;
  const highCount     = suppressionFlags.filter(f => f.severity === 'HIGH').length;

  if (criticalCount >= 1) return 'CRITICAL';
  if (highCount >= 1)     return 'HIGH';
  if (warningFlags.length >= 2) return 'MEDIUM';
  if (warningFlags.length >= 1) return 'LOW';
  return 'NONE';
}

// ─────────────────────────────────────────────────────────────
// USER-FACING EXPLAINABILITY
// ─────────────────────────────────────────────────────────────

function _buildUserFacingWarning(suppressRecommendations, sparsityLevel, suppressionFlags, warningFlags) {
  if (sparsityLevel === 'NONE') return null;

  const parts = [];

  if (suppressRecommendations) {
    parts.push(
      'Your career recommendations are temporarily paused because your assessment data needs more depth.'
    );

    const reasons = suppressionFlags.map(f => {
      switch (f.reason) {
        case SUPPRESSION_REASONS.LOW_COVERAGE:
          return 'your assessment is incomplete';
        case SUPPRESSION_REASONS.LOW_RELIABILITY:
          return 'some signals need stronger confirmation';
        case SUPPRESSION_REASONS.INSUFFICIENT_TRAITS:
          return 'too few skill areas have been assessed';
        default:
          return 'assessment quality is below the required threshold';
      }
    });

    if (reasons.length) {
      const uniqueReasons = [...new Set(reasons)];
      parts.push(`This is because ${uniqueReasons.join(' and ')}.`);
    }

    parts.push('Completing more of your assessment will unlock your personalised recommendations.');
  } else {
    parts.push('Your recommendations are available, but consider the following:');

    for (const warning of warningFlags) {
      switch (warning.reason) {
        case SUPPRESSION_REASONS.HIGH_CONTRADICTION_RATE:
          parts.push('Some of your responses appear contradictory — reviewing your answers may improve accuracy.');
          break;
        case SUPPRESSION_REASONS.HIGH_ABANDONMENT_RATE:
          parts.push('You have incomplete assessment stages — completing them will strengthen your results.');
          break;
      }
    }
  }

  return parts.join(' ');
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function _mergeThresholds(overrides = {}) {
  return { ...SPARSITY_THRESHOLDS, ...overrides };
}

module.exports = {
  evaluateSignalSparsity,
  // Exported for unit testing
  _computeSparsityLevel,
  _buildUserFacingWarning,
  SPARSITY_THRESHOLDS,
  SUPPRESSION_REASONS,
};
