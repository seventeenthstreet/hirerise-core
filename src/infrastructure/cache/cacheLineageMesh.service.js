const os = require("os");
const logger = require("../../utils/logger");

const lineageSnapshots = new Map();
const replicaFragments = new Map();

let governanceState = {
  quorumEpoch: 0,
  lastConsensusTs: null,
  lastReplicaId: null,
};

function getReplicaId() {
  return `${os.hostname()}-${process.pid}`;
}

function buildTenantLineageKey(tenantId) {
  return `tenant:${tenantId}`;
}

function preserveTenantReplayMemory(tenantId, payload) {
  const key = buildTenantLineageKey(tenantId);

  lineageSnapshots.set(key, {
    ...payload,
    tenantId,
    replicaId: getReplicaId(),
    ts: Date.now(),
  });
}

function recoverTenantReplayMemory(tenantId) {
  return lineageSnapshots.get(buildTenantLineageKey(tenantId)) || null;
}

function stitchReplicaMemory(fragment) {
  if (!fragment?.replicaId) return;

  replicaFragments.set(fragment.replicaId, {
    ...fragment,
    stitchedAt: Date.now(),
  });
}

function resurrectFromColdStart(tenantId) {
  const lineage = recoverTenantReplayMemory(tenantId);

  if (!lineage) return null;

  return {
    restored: true,
    source: "lineage-memory",
    lineage,
  };
}

function snapshotGovernanceState(payload) {
  governanceState = {
    ...governanceState,
    ...payload,
    lastConsensusTs: Date.now(),
    lastReplicaId: getReplicaId(),
  };
}

function recoverGovernanceState() {
  return governanceState;
}

function degradedLineageFallback(tenantId) {
  return (
    recoverTenantReplayMemory(tenantId) || {
      tenantId,
      degraded: true,
      reason: "LINEAGE_SNAPSHOT_MISS",
      ts: Date.now(),
    }
  );
}

module.exports = {
  preserveTenantReplayMemory,
  recoverTenantReplayMemory,
  stitchReplicaMemory,
  resurrectFromColdStart,
  snapshotGovernanceState,
  recoverGovernanceState,
  degradedLineageFallback,
  getReplicaId,
};