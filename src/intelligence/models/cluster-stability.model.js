'use strict';

/**
 * cluster-stability.model.js
 *
 * Cluster Stability Engine — Phase 4A
 *
 * Measures: "How stable is this user's capability identity over time?"
 *
 * Stability tracks:
 *   - whether a cluster appears consistently across assessments
 *   - how dominant (score magnitude) the cluster is each time
 *   - whether the cluster is rising, stable, or declining
 *   - how many assessments confirm the identity
 *
 * This is NOT predictive AI.
 * This is historical deterministic tracking.
 *
 * Architecture constraints:
 *   - pure functions only
 *   - deterministic
 *   - no AI, no ML, no hidden heuristics
 *   - no side effects
 *   - governance-safe: does not mutate cluster scores
 */

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

const STABILITY_WEIGHTS = Object.freeze({
  appearanceConsistency: 0.40,
  scoreVariance:         0.30,
  rankConsistency:       0.20,
  trendStrength:         0.10,
});

const STABILITY_LEVELS = Object.freeze({
  HIGH:     80,
  EMERGING: 55,
  UNSTABLE: 0,
});

const STABILITY_LABELS = Object.freeze({
  HIGH:     'High',
  EMERGING: 'Emerging',
  UNSTABLE: 'Unstable',
});

/** Maximum coefficient of variation (std/mean) to still be "stable" */
const VARIANCE_STABILITY_THRESHOLD = 0.15;

/** Minimum assessments to qualify for HIGH stability */
const MIN_ASSESSMENTS_FOR_HIGH_STABILITY = 3;

// ─────────────────────────────────────────────────────────────
// MAIN ENTRY POINT
// ─────────────────────────────────────────────────────────────

/**
 * Evaluates stability for each cluster based on its history.
 *
 * @param {object} params
 * @param {ClusterHistory[]} params.clusterHistories — history per cluster
 * @param {number}           params.totalAssessments — total assessment count
 * @param {object}           [params.config]
 *
 * @returns {ClusterStabilityResult}
 *
 * ClusterHistory shape:
 * {
 *   clusterId:     string,
 *   clusterLabel:  string,
 *   appearances: [
 *     {
 *       assessmentId:  string,
 *       assessedAt:    string,   // ISO date
 *       clusterScore:  number,   // 0–100
 *       clusterRank:   number,   // 1 = primary cluster
 *     }
 *   ]
 * }
 */
function evaluateClusterStability({
  clusterHistories  = [],
  totalAssessments  = 1,
  config            = {},
}) {
  const weights    = _mergeWeights(config.weights);
  const thresholds = config.thresholds ?? {};

  const stabilityProfiles = clusterHistories.map(history => {
    const appearances     = history.appearances ?? [];
    const appearanceCount = appearances.length;

    if (!appearanceCount) {
      return _emptyStabilityProfile(history.clusterId, history.clusterLabel);
    }

    const scores = appearances.map(a => a.clusterScore ?? 0);
    const ranks  = appearances.map(a => a.clusterRank  ?? 99);

    // ── Factor 1: Appearance Consistency ────────────────────
    const appearanceConsistency = _computeAppearanceConsistency(
      appearanceCount,
      totalAssessments
    );

    // ── Factor 2: Score Variance ─────────────────────────────
    const scoreVarianceStability = _computeScoreVarianceStability(scores);

    // ── Factor 3: Rank Consistency ───────────────────────────
    const rankConsistency = _computeRankConsistency(ranks);

    // ── Factor 4: Trend Strength ─────────────────────────────
    const { trendScore, trendDirection } = _computeTrendStrength(appearances);

    // ── Weighted composite ───────────────────────────────────
    const rawStabilityScore =
      weights.appearanceConsistency * appearanceConsistency +
      weights.scoreVariance         * scoreVarianceStability +
      weights.rankConsistency       * rankConsistency +
      weights.trendStrength         * trendScore;

    // Apply minimum-assessment dampening
    const dampeningFactor = _computeDampeningFactor(appearanceCount, config);
    const finalScore = clamp(rawStabilityScore * dampeningFactor, 0, 100);

    const stabilityLevel = _classifyStability(finalScore, appearanceCount, thresholds, config);

    return {
      clusterId:        history.clusterId,
      clusterLabel:     history.clusterLabel,
      stabilityScore:   round(finalScore),
      stabilityLevel,
      stabilityLabel:   STABILITY_LABELS[stabilityLevel] ?? stabilityLevel,
      trendDirection,
      appearanceCount,
      lastScore:        scores[scores.length - 1] ?? 0,
      averageScore:     round(_mean(scores)),
      factors: {
        appearanceConsistency:   round(appearanceConsistency),
        scoreVarianceStability:  round(scoreVarianceStability),
        rankConsistency:         round(rankConsistency),
        trendScore:              round(trendScore),
      },
      meta: {
        firstSeenAt:  appearances[0]?.assessedAt ?? null,
        lastSeenAt:   appearances[appearances.length - 1]?.assessedAt ?? null,
        scoreRange:   {
          min: Math.min(...scores),
          max: Math.max(...scores),
        },
      },
    };
  });

  const primaryCluster  = _identifyPrimaryCluster(stabilityProfiles);
  const emergingClusters = stabilityProfiles.filter(p => p.stabilityLevel === 'EMERGING');

  return {
    clusterStabilityProfiles: stabilityProfiles,
    primaryCluster,
    emergingClusters: emergingClusters.map(c => ({
      clusterId:      c.clusterId,
      clusterLabel:   c.clusterLabel,
      trendDirection: c.trendDirection,
    })),
    meta: {
      weights,
      totalAssessments,
      totalClusters: clusterHistories.length,
      evaluatedAt:   new Date().toISOString(),
      engineVersion: 'cluster-stability-v1',
    },
  };
}

// ─────────────────────────────────────────────────────────────
// FACTOR COMPUTATIONS
// ─────────────────────────────────────────────────────────────

function _computeAppearanceConsistency(appearanceCount, totalAssessments) {
  if (totalAssessments === 0) return 0;
  return clamp((appearanceCount / totalAssessments) * 100, 0, 100);
}

function _computeScoreVarianceStability(scores) {
  if (scores.length <= 1) return 100; // single point → no variance

  const mean = _mean(scores);
  if (mean === 0) return 0;

  const std = _stdDev(scores, mean);
  const cv  = std / mean; // coefficient of variation

  if (cv <= VARIANCE_STABILITY_THRESHOLD) return 100;

  // Linear decay: stable at 0.15 CV, 0 stability at CV ≥ 0.60
  const score = Math.max(0, 100 - ((cv - VARIANCE_STABILITY_THRESHOLD) / 0.45) * 100);
  return clamp(score, 0, 100);
}

function _computeRankConsistency(ranks) {
  if (!ranks.length) return 0;

  // Primary cluster rank = 1, secondary = 2, etc.
  // Consistency = % of appearances where rank ≤ 3 (top 3)
  const topRankAppearances = ranks.filter(r => r <= 3).length;
  const baseConsistency = (topRankAppearances / ranks.length) * 100;

  // Bonus: if always rank 1 → full score
  const alwaysPrimary = ranks.every(r => r === 1);
  return alwaysPrimary ? 100 : clamp(baseConsistency, 0, 100);
}

/**
 * Trend computation using ordinal regression over time-indexed scores.
 * Returns a normalised trendScore (0–100) and a direction label.
 */
function _computeTrendStrength(appearances) {
  if (appearances.length < 2) {
    return { trendScore: 50, trendDirection: 'STABLE' };
  }

  // Sort by date
  const sorted = [...appearances].sort(
    (a, b) => new Date(a.assessedAt) - new Date(b.assessedAt)
  );

  const scores = sorted.map(a => a.clusterScore ?? 0);
  const n      = scores.length;

  // Simple linear slope: compare last-third average vs first-third average
  const third      = Math.max(1, Math.floor(n / 3));
  const earlyMean  = _mean(scores.slice(0, third));
  const recentMean = _mean(scores.slice(-third));
  const delta      = recentMean - earlyMean;

  const RISE_THRESHOLD  = 5;   // ≥5 pts increase = RISING
  const FALL_THRESHOLD  = -5;  // ≤-5 pts decrease = DECLINING

  let trendDirection;
  let trendScore;

  if (delta >= RISE_THRESHOLD) {
    trendDirection = 'RISING';
    trendScore     = clamp(50 + (delta / 2), 50, 100);
  } else if (delta <= FALL_THRESHOLD) {
    trendDirection = 'DECLINING';
    trendScore     = clamp(50 + (delta / 2), 0, 50);
  } else {
    trendDirection = 'STABLE';
    trendScore     = 75; // stable is positive signal for reliability
  }

  return { trendScore, trendDirection };
}

/**
 * Dampens score for clusters seen in very few assessments.
 * Prevents a single-assessment cluster from claiming HIGH stability.
 */
function _computeDampeningFactor(appearanceCount, config = {}) {
  const minForFull = config.minAssessmentsForFullStability ?? MIN_ASSESSMENTS_FOR_HIGH_STABILITY;
  if (appearanceCount >= minForFull) return 1.0;
  return 0.4 + (appearanceCount / minForFull) * 0.6;
}

// ─────────────────────────────────────────────────────────────
// CLASSIFICATION
// ─────────────────────────────────────────────────────────────

function _classifyStability(score, appearanceCount, thresholds = {}, config = {}) {
  const high     = thresholds.HIGH     ?? STABILITY_LEVELS.HIGH;
  const emerging = thresholds.EMERGING ?? STABILITY_LEVELS.EMERGING;
  const minAssessments = config.minAssessmentsForHighStability ?? MIN_ASSESSMENTS_FOR_HIGH_STABILITY;

  if (score >= high && appearanceCount >= minAssessments) return 'HIGH';
  if (score >= emerging) return 'EMERGING';
  return 'UNSTABLE';
}

function _identifyPrimaryCluster(profiles) {
  if (!profiles.length) return null;

  // Primary = highest stability score, tiebreak by average score
  const sorted = [...profiles].sort((a, b) => {
    if (b.stabilityScore !== a.stabilityScore) return b.stabilityScore - a.stabilityScore;
    return b.averageScore - a.averageScore;
  });

  const primary = sorted[0];
  return {
    clusterId:      primary.clusterId,
    clusterLabel:   primary.clusterLabel,
    stabilityLevel: primary.stabilityLevel,
    stabilityLabel: primary.stabilityLabel,
  };
}

function _emptyStabilityProfile(clusterId, clusterLabel) {
  return {
    clusterId,
    clusterLabel:   clusterLabel ?? clusterId,
    stabilityScore: 0,
    stabilityLevel: 'UNSTABLE',
    stabilityLabel: 'Unstable',
    trendDirection: 'STABLE',
    appearanceCount: 0,
    lastScore:       0,
    averageScore:    0,
    factors: {
      appearanceConsistency:  0,
      scoreVarianceStability: 0,
      rankConsistency:        0,
      trendScore:             0,
    },
    meta: {
      firstSeenAt: null,
      lastSeenAt:  null,
      scoreRange:  { min: 0, max: 0 },
    },
  };
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function _mergeWeights(overrides = {}) {
  return { ...STABILITY_WEIGHTS, ...overrides };
}

function _mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function _stdDev(arr, mean) {
  if (arr.length <= 1) return 0;
  const variance = arr.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / arr.length;
  return Math.sqrt(variance);
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
  evaluateClusterStability,
  // Exported for unit testing
  _computeAppearanceConsistency,
  _computeScoreVarianceStability,
  _computeRankConsistency,
  _computeTrendStrength,
  _computeDampeningFactor,
  _classifyStability,
  STABILITY_WEIGHTS,
  STABILITY_LEVELS,
  STABILITY_LABELS,
};
