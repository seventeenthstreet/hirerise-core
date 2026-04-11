const logger = require("../../utils/logger");
const quorum = require("./quorumReplication.service");
const pressure = require("./regionalPressureMesh.service");

const FAILOVER_COOLDOWN_MS = Number(
  process.env.FAILOVER_COOLDOWN_MS || 30000
);

const tenantFailoverMap = new Map();

function getActiveFailover(tenantId) {
  return tenantFailoverMap.get(tenantId) || null;
}

function isCooldownActive(entry) {
  if (!entry) return false;
  return Date.now() - entry.ts < FAILOVER_COOLDOWN_MS;
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
    return preferredRegion;
  }

  // Prevent stale replay resurrection
  if (replica.revision < revisionFloor) {
    logger.warn(
      `[Patch21] stale failover prevented for tenant=${tenantId}`
    );
    return preferredRegion;
  }

  const failoverState = {
    tenantId,
    primaryRegion: preferredRegion,
    region: peer,
    revision: replica.revision,
    ts: Date.now(),
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