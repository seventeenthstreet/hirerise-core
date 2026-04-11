const logger = require("../../utils/logger");

const DEGRADE_THRESHOLD = Number(
  process.env.REGION_DEGRADE_THRESHOLD || 0.75
);

const RECOVERY_THRESHOLD = Number(
  process.env.REGION_RECOVERY_THRESHOLD || 0.35
);

const regionPressure = new Map();

function normalizeMetric(value) {
  const num = Number(value || 0);

  if (!Number.isFinite(num)) return 0;
  if (num < 0) return 0;
  if (num > 1) return 1;

  return num;
}

function computePressure(metrics = {}) {
  const memoryPressure = normalizeMetric(metrics.memoryPressure);
  const latencySurge = normalizeMetric(metrics.latencySurge);
  const replayQueueDepth = normalizeMetric(metrics.replayQueueDepth);
  const cacheMissStorm = normalizeMetric(metrics.cacheMissStorm);

  return (
    memoryPressure * 0.35 +
    latencySurge * 0.25 +
    replayQueueDepth * 0.25 +
    cacheMissStorm * 0.15
  );
}

function updateRegionPressure(region, metrics = {}) {
  if (!region) return 0;

  const score = computePressure(metrics);

  regionPressure.set(region, {
    score,
    metrics: {
      memoryPressure: normalizeMetric(metrics.memoryPressure),
      latencySurge: normalizeMetric(metrics.latencySurge),
      replayQueueDepth: normalizeMetric(metrics.replayQueueDepth),
      cacheMissStorm: normalizeMetric(metrics.cacheMissStorm),
    },
    updatedAt: Date.now(),
  });

  return score;
}

function getRegionPressure(region) {
  return regionPressure.get(region) || null;
}

function getHealthiestPeer(regions = [], revisionFloor = 0, replica = null) {
  if (!Array.isArray(regions) || regions.length === 0) {
    return null;
  }

  const eligiblePeers = [...regions]
    .filter(Boolean)
    .filter((region) => regionPressure.has(region))
    .filter(() => !replica || replica.revision >= revisionFloor);

  if (eligiblePeers.length === 0) {
    return null;
  }

  return eligiblePeers.sort(
    (a, b) =>
      (regionPressure.get(a)?.score || 0) -
      (regionPressure.get(b)?.score || 0)
  )[0];
}

function isRegionDegraded(region) {
  return (
    (regionPressure.get(region)?.score || 0) >=
    DEGRADE_THRESHOLD
  );
}

function isRegionRecovered(region) {
  return (
    (regionPressure.get(region)?.score || 1) <=
    RECOVERY_THRESHOLD
  );
}

function clearRegionPressure(region) {
  if (!region) return false;
  return regionPressure.delete(region);
}

function getPressureSnapshot() {
  return [...regionPressure.entries()].map(([region, value]) => ({
    region,
    ...value,
  }));
}

function logPressureSnapshot() {
  logger.info(
    "[Patch21] regional pressure snapshot",
    getPressureSnapshot()
  );
}

module.exports = {
  computePressure,
  updateRegionPressure,
  getRegionPressure,
  getHealthiestPeer,
  isRegionDegraded,
  isRegionRecovered,
  clearRegionPressure,
  getPressureSnapshot,
  logPressureSnapshot,
  regionPressure,
};