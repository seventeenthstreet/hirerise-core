'use strict';

/**
 * cluster-drift.model.js
 *
 * Cluster Drift Detection Engine — Phase 4A
 *
 * Detects and classifies changes in a user's primary cluster identity
 * across reassessments.
 *
 * Drift is NOT a prediction.
 * Drift is a historical observation of capability identity movement.
 *
 * Architecture constraints:
 *   - pure functions only
 *   - deterministic
 *   - configurable thresholds (no hidden heuristics)
 *   - no AI, no ML
 *   - no side effects
 */

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

const DRIFT_LEVELS = Object.freeze({
  NONE:         'None',
  MINOR:        'Minor',
  MODERATE:     'Moderate',
  SIGNIFICANT:  'Significant',
});

const DRIFT_THRESHOLDS = Object.freeze({
  MINOR:        10,   // primary cluster score change ≥ 10 pts
  MODERATE:     20,   // primary cluster change ≥ 20 pts OR cluster swap with medium delta
  SIGNIFICANT:  30,   // primary cluster change ≥ 30 pts OR large cluster swap
});

const CLUSTER_SWAP_PENALTY = 15; // extra drift score when primary cluster identity changes

// ─────────────────────────────────────────────────────────────
// MAIN ENTRY POINT
// ─────────────────────────────────────────────────────────────

/**
 * Evaluates cluster drift between two assessment snapshots.
 *
 * @param {object} params
 * @param {AssessmentSnapshot} params.previousSnapshot
 * @param {AssessmentSnapshot} params.currentSnapshot
 * @param {object}             [params.config]
 *
 * @returns {ClusterDriftResult}
 *
 * AssessmentSnapshot shape:
 * {
 *   assessmentId:   string,
 *   assessedAt:     string,           // ISO date
 *   primaryCluster: { clusterId, clusterLabel, score },
 *   allClusters:    [{ clusterId, clusterLabel, score, rank }]
 * }
 */
function evaluateClusterDrift({
  previousSnapshot = null,
  currentSnapshot  = null,
  config           = {},
}) {
  if (!previousSnapshot || !currentSnapshot) {
    return _noDriftResult('Insufficient assessment history for drift evaluation.');
  }

  const thresholds = _mergeThresholds(config.thresholds);

  const prevPrimary = previousSnapshot.primaryCluster ?? {};
  const currPrimary = currentSnapshot.primaryCluster  ?? {};

  // ── 1. Detect cluster swap ───────────────────────────────
  const clusterSwapped = prevPrimary.clusterId !== currPrimary.clusterId;

  // ── 2. Score delta on primary cluster (comparing same cluster across time) ─
  const primaryScoreDelta = _computePrimaryScoreDelta(
    previousSnapshot.allClusters,
    currentSnapshot.allClusters,
    prevPrimary.clusterId
  );

  // ── 3. Cluster swap delta (how different are the two primaries?) ──────────
  const swapScoreDelta = clusterSwapped
    ? Math.abs((currPrimary.score ?? 0) - (prevPrimary.score ?? 0))
    : 0;

  // ── 4. Compute composite drift score ─────────────────────
  let driftScore = Math.abs(primaryScoreDelta);

  if (clusterSwapped) {
    driftScore += CLUSTER_SWAP_PENALTY + swapScoreDelta * 0.5;
  }

  driftScore = clamp(driftScore, 0, 100);

  const driftLevel = _classifyDrift(driftScore, thresholds);

  // ── 5. Delta per cluster ──────────────────────────────────
  const clusterDeltas = _computeAllClusterDeltas(
    previousSnapshot.allClusters ?? [],
    currentSnapshot.allClusters  ?? []
  );

  // ── 6. Explainability ─────────────────────────────────────
  const explanation = _buildDriftExplanation(
    clusterSwapped,
    driftLevel,
    prevPrimary,
    currPrimary,
    primaryScoreDelta,
    clusterDeltas
  );

  return {
    driftScore:   round(driftScore),
    driftLevel,
    clusterSwapped,
    previousPrimaryCluster: {
      clusterId:    prevPrimary.clusterId    ?? null,
      clusterLabel: prevPrimary.clusterLabel ?? null,
      score:        prevPrimary.score        ?? null,
    },
    currentPrimaryCluster: {
      clusterId:    currPrimary.clusterId    ?? null,
      clusterLabel: currPrimary.clusterLabel ?? null,
      score:        currPrimary.score        ?? null,
    },
    primaryScoreDelta: round(primaryScoreDelta),
    clusterDeltas,
    explanation,
    meta: {
      previousAssessmentId: previousSnapshot.assessmentId ?? null,
      previousAssessedAt:   previousSnapshot.assessedAt   ?? null,
      currentAssessmentId:  currentSnapshot.assessmentId  ?? null,
      currentAssessedAt:    currentSnapshot.assessedAt    ?? null,
      thresholds,
      engineVersion: 'cluster-drift-v1',
    },
  };
}

// ─────────────────────────────────────────────────────────────
// LONGITUDINAL DRIFT HISTORY
// ─────────────────────────────────────────────────────────────

/**
 * Evaluates drift across a full sequence of assessments.
 * Returns per-transition drift records and overall trend summary.
 *
 * @param {AssessmentSnapshot[]} snapshots — ordered oldest → newest
 * @param {object}               [config]
 * @returns {LongitudinalDriftResult}
 */
function evaluateLongitudinalDrift(snapshots = [], config = {}) {
  if (snapshots.length < 2) {
    return {
      transitions: [],
      overallDriftLevel: DRIFT_LEVELS.NONE,
      averageDriftScore: 0,
      maxDriftScore:     0,
      driftEvents:       [],
      identityStability: 'INSUFFICIENT_DATA',
      meta: { totalAssessments: snapshots.length, engineVersion: 'cluster-drift-v1' },
    };
  }

  const sorted = [...snapshots].sort(
    (a, b) => new Date(a.assessedAt) - new Date(b.assessedAt)
  );

  const transitions = [];

  for (let i = 1; i < sorted.length; i++) {
    const result = evaluateClusterDrift({
      previousSnapshot: sorted[i - 1],
      currentSnapshot:  sorted[i],
      config,
    });
    transitions.push(result);
  }

  const driftScores  = transitions.map(t => t.driftScore);
  const avgDrift     = _mean(driftScores);
  const maxDrift     = Math.max(...driftScores);

  const significantDriftEvents = transitions.filter(
    t => t.driftLevel === DRIFT_LEVELS.SIGNIFICANT || t.driftLevel === DRIFT_LEVELS.MODERATE
  );

  const overallDriftLevel = _classifyDrift(avgDrift, _mergeThresholds(config.thresholds));
  const identityStability = _computeIdentityStability(sorted, config);

  return {
    transitions,
    overallDriftLevel,
    averageDriftScore: round(avgDrift),
    maxDriftScore:     round(maxDrift),
    driftEvents: significantDriftEvents.map(e => ({
      previousPrimaryCluster: e.previousPrimaryCluster,
      currentPrimaryCluster:  e.currentPrimaryCluster,
      driftLevel:             e.driftLevel,
      driftScore:             e.driftScore,
      assessedAt:             e.meta.currentAssessedAt,
    })),
    identityStability,
    meta: {
      totalAssessments: snapshots.length,
      totalTransitions: transitions.length,
      evaluatedAt:      new Date().toISOString(),
      engineVersion:    'cluster-drift-v1',
    },
  };
}

// ─────────────────────────────────────────────────────────────
// FACTOR COMPUTATIONS
// ─────────────────────────────────────────────────────────────

function _computePrimaryScoreDelta(prevClusters, currClusters, clusterId) {
  if (!clusterId) return 0;

  const prevCluster = (prevClusters ?? []).find(c => c.clusterId === clusterId);
  const currCluster = (currClusters ?? []).find(c => c.clusterId === clusterId);

  if (!prevCluster || !currCluster) return 0;

  return (currCluster.score ?? 0) - (prevCluster.score ?? 0);
}

function _computeAllClusterDeltas(prevClusters, currClusters) {
  const prevMap = Object.fromEntries(prevClusters.map(c => [c.clusterId, c]));
  const currMap = Object.fromEntries(currClusters.map(c => [c.clusterId, c]));

  const allIds = new Set([...Object.keys(prevMap), ...Object.keys(currMap)]);
  const deltas = [];

  for (const id of allIds) {
    const prev = prevMap[id];
    const curr = currMap[id];

    deltas.push({
      clusterId:    id,
      clusterLabel: curr?.clusterLabel ?? prev?.clusterLabel ?? id,
      previousScore: prev?.score ?? null,
      currentScore:  curr?.score ?? null,
      scoreDelta:   curr && prev ? round((curr.score ?? 0) - (prev.score ?? 0)) : null,
      rankDelta:    curr && prev ? (prev.rank ?? 99) - (curr.rank ?? 99) : null,
      status: !prev ? 'NEW' : !curr ? 'DROPPED' : 'CONTINUED',
    });
  }

  return deltas;
}

function _computeIdentityStability(sortedSnapshots, config = {}) {
  if (sortedSnapshots.length < 2) return 'INSUFFICIENT_DATA';

  const primaryIds = sortedSnapshots.map(s => s.primaryCluster?.clusterId ?? null);
  const swaps      = primaryIds.filter((id, i) => i > 0 && id !== primaryIds[i - 1]).length;
  const swapRate   = swaps / (sortedSnapshots.length - 1);

  const stableThreshold   = config.identityStableSwapRate   ?? 0.10;
  const unstableThreshold = config.identityUnstableSwapRate ?? 0.40;

  if (swapRate <= stableThreshold)   return 'STABLE';
  if (swapRate >= unstableThreshold) return 'VOLATILE';
  return 'TRANSITIONING';
}

// ─────────────────────────────────────────────────────────────
// CLASSIFICATION
// ─────────────────────────────────────────────────────────────

function _classifyDrift(score, thresholds = {}) {
  const significant = thresholds.SIGNIFICANT ?? DRIFT_THRESHOLDS.SIGNIFICANT;
  const moderate    = thresholds.MODERATE    ?? DRIFT_THRESHOLDS.MODERATE;
  const minor       = thresholds.MINOR       ?? DRIFT_THRESHOLDS.MINOR;

  if (score >= significant) return DRIFT_LEVELS.SIGNIFICANT;
  if (score >= moderate)    return DRIFT_LEVELS.MODERATE;
  if (score >= minor)       return DRIFT_LEVELS.MINOR;
  return DRIFT_LEVELS.NONE;
}

// ─────────────────────────────────────────────────────────────
// EXPLAINABILITY
// ─────────────────────────────────────────────────────────────

function _buildDriftExplanation(
  clusterSwapped,
  driftLevel,
  prevPrimary,
  currPrimary,
  primaryScoreDelta,
  clusterDeltas
) {
  const parts = [];

  if (driftLevel === DRIFT_LEVELS.NONE) {
    parts.push('Your capability identity is consistent with your previous assessment.');
    return parts.join(' ');
  }

  if (clusterSwapped) {
    parts.push(
      `Your primary cluster changed from "${prevPrimary.clusterLabel ?? prevPrimary.clusterId}" ` +
      `to "${currPrimary.clusterLabel ?? currPrimary.clusterId}".`
    );
  } else if (Math.abs(primaryScoreDelta) > 0) {
    const direction = primaryScoreDelta > 0 ? 'increased' : 'decreased';
    parts.push(
      `Your primary cluster "${currPrimary.clusterLabel ?? currPrimary.clusterId}" score ` +
      `${direction} by ${Math.abs(primaryScoreDelta).toFixed(1)} points.`
    );
  }

  const risingClusters = clusterDeltas
    .filter(d => d.scoreDelta !== null && d.scoreDelta >= 10)
    .map(d => d.clusterLabel);

  if (risingClusters.length) {
    parts.push(`Strengthened areas: ${risingClusters.join(', ')}.`);
  }

  if (driftLevel === DRIFT_LEVELS.SIGNIFICANT) {
    parts.push(
      'This represents a significant shift in your capability profile. ' +
      'Consider reviewing your assessment responses to confirm accuracy.'
    );
  }

  return parts.join(' ');
}

function _noDriftResult(reason) {
  return {
    driftScore:    0,
    driftLevel:    DRIFT_LEVELS.NONE,
    clusterSwapped: false,
    previousPrimaryCluster: null,
    currentPrimaryCluster:  null,
    primaryScoreDelta: 0,
    clusterDeltas: [],
    explanation:   reason,
    meta: {
      previousAssessmentId: null,
      previousAssessedAt:   null,
      currentAssessmentId:  null,
      currentAssessedAt:    null,
      engineVersion: 'cluster-drift-v1',
    },
  };
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function _mergeThresholds(overrides = {}) {
  return { ...DRIFT_THRESHOLDS, ...overrides };
}

function _mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
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
  evaluateClusterDrift,
  evaluateLongitudinalDrift,
  // Exported for unit testing
  _computePrimaryScoreDelta,
  _computeAllClusterDeltas,
  _computeIdentityStability,
  _classifyDrift,
  DRIFT_LEVELS,
  DRIFT_THRESHOLDS,
};
