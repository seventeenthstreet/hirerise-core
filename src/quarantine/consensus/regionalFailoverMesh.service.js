const logger = require("../../utils/logger");
const quorum = require("./quorumReplication.service");
const pressure = require("./regionalPressureMesh.service");
const predictiveSplitBrain = require("./predictiveSplitBrain.service");

const FAILOVER_COOLDOWN_MS = Math.max(
  10000,
  Number(process.env.FAILOVER_COOLDOWN_MS) || 30000
);

const tenantFailoverMap = new Map();

function getActiveFailover(tenantId) {
  return tenantFailoverMap.get(tenantId) || null;
}

function isCooldownActive(entry) {
  if (!entry) return false;
  return Date.now() - entry.ts < FAILOVER_COOLDOWN_MS;
}

function isPredictiveDampened(tenantId) {
  return predictiveSplitBrain.isPromotionDampened(tenantId);
}

function resolveReadRegion(
  tenantId,
  preferredRegion,
  revisionFloor = 0
) {
  if (!tenantId) return preferredRegion;

  const replica = quorum.getReplica(tenantId);
  if (!replica) return preferredRegion;

  const existing = getActiveFailover(tenantId);

  // Patch 24 — predictive split-brain dampening barrier
  if (isPredictiveDampened(tenantId)) {
    logger.warn(
      `[Patch24] failover dampened due to predictive split-brain risk tenant=${tenantId}`
    );

    return existing?.region || preferredRegion;
  }

  // Prevent route flapping during repeated pressure spikes
  if (
    existing &&
    isCooldownActive(existing) &&
    existing.revision >= revisionFloor
  ) {
    return existing.region;
  }

  // Primary healthy → restore direct routing
  if (!pressure.isRegionDegraded(preferredRegion)) {
    tenantFailoverMap.delete(tenantId);
    return preferredRegion;
  }

  const peer = pressure.getHealthiestPeer(
    replica.peers,
    revisionFloor,
    replica
  );

  // No safe peer available → preserve primary
  if (!peer || peer === preferredRegion) {
    return existing?.region || preferredRegion;
  }

  // Prevent stale replay resurrection
  if (Number(replica.revision || 0) < Number(revisionFloor || 0)) {
    logger.warn(
      `[Patch21] stale failover prevented for tenant=${tenantId}`
    );
    return existing?.region || preferredRegion;
  }

  const failoverState = {
    tenantId,
    primaryRegion: preferredRegion,
    region: peer,
    revision: Number(replica.revision || 0),
    ts: Date.now(),
    reason: "pressure_failover",
  };

  tenantFailoverMap.set(tenantId, failoverState);

  logger.info(
    `[Patch21] tenant failover activated tenant=${tenantId} peer=${peer}`
  );

  return peer;
}

function restorePrimaryIfHealthy(tenantId, primaryRegion) {
  const existing = getActiveFailover(tenantId);
  if (!existing) return false;

  // Patch 24 — block restore while predictive risk remains high
  if (isPredictiveDampened(tenantId)) {
    logger.warn(
      `[Patch24] primary restore delayed by split-brain dampening tenant=${tenantId}`
    );
    return false;
  }

  if (!pressure.isRegionRecovered(primaryRegion)) {
    return false;
  }

  // Prevent premature restore if failover just happened
  if (isCooldownActive(existing)) {
    return false;
  }

  tenantFailoverMap.delete(tenantId);

  logger.info(
    `[Patch21] primary ownership restored tenant=${tenantId}`
  );

  return true;
}

function clearTenantFailover(tenantId) {
  return tenantFailoverMap.delete(tenantId);
}

function getFailoverSnapshot() {
  return [...tenantFailoverMap.entries()].map(
    ([tenantId, state]) => ({
      tenantId,
      ...state,
      predictiveDampened: isPredictiveDampened(tenantId),
    })
  );
}

module.exports = {
  resolveReadRegion,
  restorePrimaryIfHealthy,
  clearTenantFailover,
  getActiveFailover,
  getFailoverSnapshot,
  tenantFailoverMap,
};