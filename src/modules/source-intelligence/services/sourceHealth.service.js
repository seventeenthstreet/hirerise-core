'use strict';

/**
 * src/modules/source-intelligence/services/sourceHealth.service.js
 *
 * Health Model (deliverable #10).
 *
 * Records observations (from a connector's own health checks, from COM's
 * collection attempts, or from manual probes) and derives:
 *   - reliabilityScore (0-100, feeds sourceTrust.service's blend)
 *   - healthStatus (healthy | degraded | unhealthy | unknown)
 *   - failureCount / lastSuccessfulAccess / lastFailure
 *
 * This module owns the *health* domain only — it never writes governance
 * status (active/blocked/...); sourceGovernance.service listens to health
 * outcomes and decides whether they warrant a lifecycle transition
 * (e.g. auto-flagging REVIEW_REQUIRED after sustained failures).
 */

const healthRepo = require('../repositories/sourceHealth.repository');
const sourceRegistryRepo = require('../repositories/sourceRegistry.repository');
const { HEALTH_STATUS } = require('../models/source.model');
const logger = require('../../../utils/logger');

const DEFAULT_ALERT_THRESHOLDS = Object.freeze({
  degradedFailureRate: 0.2, // >=20% failures in window => degraded
  unhealthyFailureRate: 0.5, // >=50% failures in window => unhealthy
  minSampleSizeForDegraded: 3,
});

function deriveHealthStatus(rollup, thresholds = DEFAULT_ALERT_THRESHOLDS) {
  if (!rollup || rollup.sampleSize === 0) return HEALTH_STATUS.UNKNOWN;

  const failureRate = rollup.failureCount / rollup.sampleSize;

  if (rollup.sampleSize >= thresholds.minSampleSizeForDegraded) {
    if (failureRate >= thresholds.unhealthyFailureRate) {
      return HEALTH_STATUS.UNHEALTHY;
    }
    if (failureRate >= thresholds.degradedFailureRate) {
      return HEALTH_STATUS.DEGRADED;
    }
  }

  return HEALTH_STATUS.HEALTHY;
}

function reliabilityScoreFromRollup(rollup) {
  if (!rollup || rollup.sampleSize === 0) return null;
  return Math.round((rollup.successCount / rollup.sampleSize) * 100);
}

/**
 * Records a single health observation for a source and refreshes the
 * denormalized health cache on sim_sources so reads stay O(1).
 *
 * @returns {{ snapshot, healthStatus, reliabilityScore, statusChanged }}
 */
async function recordObservation(sourceId, {
  succeeded,
  latencyMs = null,
  failureReason = null,
  rawMetadata = null,
} = {}, { actorId = 'system' } = {}) {
  if (typeof succeeded !== 'boolean') {
    throw new TypeError('recordObservation requires a boolean `succeeded`');
  }

  const rollupBefore = await healthRepo.getRollup(sourceId);
  const previousHealthStatus = deriveHealthStatus(rollupBefore);

  const snapshot = await healthRepo.recordSnapshot(sourceId, {
    succeeded,
    latencyMs,
    failureReason,
    rawMetadata,
    observedAt: new Date().toISOString(),
  });

  const rollupAfter = await healthRepo.getRollup(sourceId);
  const healthStatus = deriveHealthStatus(rollupAfter);
  const reliabilityScore = reliabilityScoreFromRollup(rollupAfter);

  await sourceRegistryRepo.update(
    sourceId,
    {
      healthStatus,
      lastSuccessfulAccess: rollupAfter.lastSuccessfulAccess,
      lastFailure: rollupAfter.lastFailure,
      failureCount: rollupAfter.failureCount,
      reliabilityScore,
    },
    actorId
  );

  const statusChanged = previousHealthStatus !== healthStatus;

  if (statusChanged) {
    logger.info('[SIM.health] health status changed', {
      sourceId,
      from: previousHealthStatus,
      to: healthStatus,
    });
  }

  return { snapshot, healthStatus, reliabilityScore, statusChanged, previousHealthStatus };
}

async function getHealthSummary(sourceId) {
  const [rollup, latest] = await Promise.all([
    healthRepo.getRollup(sourceId),
    healthRepo.getLatest(sourceId),
  ]);

  return {
    sourceId,
    healthStatus: deriveHealthStatus(rollup),
    reliabilityScore: reliabilityScoreFromRollup(rollup),
    sampleSize: rollup.sampleSize,
    successCount: rollup.successCount,
    failureCount: rollup.failureCount,
    lastSuccessfulAccess: rollup.lastSuccessfulAccess,
    lastFailure: rollup.lastFailure,
    latestObservation: latest,
  };
}

async function getHistory(sourceId, options) {
  return healthRepo.listRecent(sourceId, options);
}

module.exports = {
  DEFAULT_ALERT_THRESHOLDS,
  deriveHealthStatus,
  reliabilityScoreFromRollup,
  recordObservation,
  getHealthSummary,
  getHistory,
};
