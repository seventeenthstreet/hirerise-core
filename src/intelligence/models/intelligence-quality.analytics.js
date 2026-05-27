'use strict';

/**
 * intelligence-quality.analytics.js
 *
 * Analytics telemetry for Phase 4A intelligence quality systems.
 *
 * Emits modular, idempotency-safe, governance-safe telemetry events for:
 *   - signal_coverage_evaluated
 *   - low_signal_coverage_detected
 *   - cluster_stability_updated
 *   - cluster_drift_detected
 *   - reassessment_completed
 *   - reliability_threshold_crossed
 *
 * Architecture constraints:
 *   - modular: each event is independently emittable
 *   - no orchestration leakage (no cross-event dependencies)
 *   - idempotency-safe: events include deduplication keys
 *   - governance-safe: no PII in telemetry payloads
 *   - pure event builder functions (no side effects)
 *   - analytics adapter must be injected — not imported
 */

// ─────────────────────────────────────────────────────────────
// EVENT TYPE REGISTRY
// ─────────────────────────────────────────────────────────────

const IntelligenceQualityEvents = Object.freeze({
  SIGNAL_COVERAGE_EVALUATED:    'signal_coverage_evaluated',
  LOW_SIGNAL_COVERAGE_DETECTED: 'low_signal_coverage_detected',
  CLUSTER_STABILITY_UPDATED:    'cluster_stability_updated',
  CLUSTER_DRIFT_DETECTED:       'cluster_drift_detected',
  REASSESSMENT_COMPLETED:       'reassessment_completed',
  RELIABILITY_THRESHOLD_CROSSED: 'reliability_threshold_crossed',
});

// ─────────────────────────────────────────────────────────────
// EVENT BUILDERS (pure — no side effects)
// ─────────────────────────────────────────────────────────────

/**
 * Emitted every time signal coverage is computed for a user.
 */
function buildSignalCoverageEvaluatedEvent({ userId, assessmentId, coverageResult }) {
  return {
    eventType:   IntelligenceQualityEvents.SIGNAL_COVERAGE_EVALUATED,
    dedupeKey:   `signal_coverage_evaluated:${userId}:${assessmentId}`,
    occurredAt:  new Date().toISOString(),
    payload: {
      userId,
      assessmentId,
      coverageScore:  coverageResult.coverageScore,
      coverageLevel:  coverageResult.coverageLevel,
      traitGapCount:  (coverageResult.traitGaps ?? []).length,
      engineVersion:  coverageResult.meta?.engineVersion ?? 'unknown',
    },
  };
}

/**
 * Emitted only when coverage is LOW — allows alerting on quality regression.
 */
function buildLowSignalCoverageDetectedEvent({ userId, assessmentId, coverageResult }) {
  if (coverageResult.coverageLevel !== 'LOW') return null;

  return {
    eventType:   IntelligenceQualityEvents.LOW_SIGNAL_COVERAGE_DETECTED,
    dedupeKey:   `low_signal_coverage:${userId}:${assessmentId}`,
    occurredAt:  new Date().toISOString(),
    payload: {
      userId,
      assessmentId,
      coverageScore:    coverageResult.coverageScore,
      traitGapCount:    (coverageResult.traitGaps ?? []).length,
      suppressionActive: coverageResult.suppressRecommendations ?? false,
    },
  };
}

/**
 * Emitted when a cluster's stability profile is computed or updated.
 */
function buildClusterStabilityUpdatedEvent({ userId, clusterStabilityResult }) {
  const profiles = clusterStabilityResult.clusterStabilityProfiles ?? [];

  return {
    eventType:  IntelligenceQualityEvents.CLUSTER_STABILITY_UPDATED,
    dedupeKey:  `cluster_stability_updated:${userId}:${clusterStabilityResult.meta?.evaluatedAt ?? Date.now()}`,
    occurredAt: new Date().toISOString(),
    payload: {
      userId,
      totalClusters:          clusterStabilityResult.meta?.totalClusters ?? 0,
      totalAssessments:       clusterStabilityResult.meta?.totalAssessments ?? 0,
      primaryClusterId:       clusterStabilityResult.primaryCluster?.clusterId ?? null,
      primaryStabilityLevel:  clusterStabilityResult.primaryCluster?.stabilityLevel ?? null,
      emergingClusterCount:   (clusterStabilityResult.emergingClusters ?? []).length,
      clusterSummary: profiles.map(p => ({
        clusterId:      p.clusterId,
        stabilityLevel: p.stabilityLevel,
        trendDirection: p.trendDirection,
      })),
    },
  };
}

/**
 * Emitted when drift is detected between assessment snapshots.
 * Only emitted when driftLevel is not 'None'.
 */
function buildClusterDriftDetectedEvent({ userId, driftResult }) {
  if (driftResult.driftLevel === 'None') return null;

  return {
    eventType:  IntelligenceQualityEvents.CLUSTER_DRIFT_DETECTED,
    dedupeKey:  `cluster_drift:${userId}:${driftResult.meta?.currentAssessmentId ?? Date.now()}`,
    occurredAt: new Date().toISOString(),
    payload: {
      userId,
      driftScore:                driftResult.driftScore,
      driftLevel:                driftResult.driftLevel,
      clusterSwapped:            driftResult.clusterSwapped,
      previousPrimaryClusterId:  driftResult.previousPrimaryCluster?.clusterId ?? null,
      currentPrimaryClusterId:   driftResult.currentPrimaryCluster?.clusterId  ?? null,
      previousAssessmentId:      driftResult.meta?.previousAssessmentId ?? null,
      currentAssessmentId:       driftResult.meta?.currentAssessmentId  ?? null,
    },
  };
}

/**
 * Emitted when a user completes a reassessment (has ≥2 assessment snapshots).
 */
function buildReassessmentCompletedEvent({
  userId,
  currentAssessmentId,
  previousAssessmentId,
  coverageScore,
  reliabilityScore,
  primaryClusterId,
}) {
  return {
    eventType:  IntelligenceQualityEvents.REASSESSMENT_COMPLETED,
    dedupeKey:  `reassessment_completed:${userId}:${currentAssessmentId}`,
    occurredAt: new Date().toISOString(),
    payload: {
      userId,
      currentAssessmentId,
      previousAssessmentId,
      coverageScore,
      reliabilityScore,
      primaryClusterId,
    },
  };
}

/**
 * Emitted when a trait crosses from LOW → MEDIUM or MEDIUM → HIGH reliability.
 * Enables alerting on meaningful quality improvements.
 */
function buildReliabilityThresholdCrossedEvent({
  userId,
  assessmentId,
  traitKey,
  previousLevel,
  currentLevel,
  reliabilityScore,
}) {
  // Only emit on upward transitions
  const levelRank = { LOW: 0, MEDIUM: 1, HIGH: 2 };
  const prevRank  = levelRank[previousLevel] ?? 0;
  const currRank  = levelRank[currentLevel]  ?? 0;

  if (currRank <= prevRank) return null;

  return {
    eventType:  IntelligenceQualityEvents.RELIABILITY_THRESHOLD_CROSSED,
    dedupeKey:  `reliability_threshold:${userId}:${assessmentId}:${traitKey}:${currentLevel}`,
    occurredAt: new Date().toISOString(),
    payload: {
      userId,
      assessmentId,
      traitKey,
      previousLevel,
      currentLevel,
      reliabilityScore,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// EMIT HELPERS (adapter-injected)
// ─────────────────────────────────────────────────────────────

/**
 * Emits a batch of intelligence quality events via the provided analytics adapter.
 * Null events (conditional emits that didn't trigger) are safely filtered.
 *
 * @param {object[]}  events          — built via builder functions above
 * @param {function}  analyticsAdapter — async (event) => void
 * @param {object}    [logger]        — optional logger with .warn()
 */
async function emitIntelligenceQualityEvents(events, analyticsAdapter, logger) {
  const validEvents = (events ?? []).filter(Boolean);

  for (const event of validEvents) {
    try {
      await analyticsAdapter(event);
    } catch (err) {
      // Analytics failures must never break the intelligence pipeline
      if (logger?.warn) {
        logger.warn('[intelligence-quality.analytics] Event emission failed', {
          eventType: event.eventType,
          error:     err?.message ?? 'Unknown analytics error',
        });
      }
    }
  }
}

module.exports = {
  IntelligenceQualityEvents,
  buildSignalCoverageEvaluatedEvent,
  buildLowSignalCoverageDetectedEvent,
  buildClusterStabilityUpdatedEvent,
  buildClusterDriftDetectedEvent,
  buildReassessmentCompletedEvent,
  buildReliabilityThresholdCrossedEvent,
  emitIntelligenceQualityEvents,
};
