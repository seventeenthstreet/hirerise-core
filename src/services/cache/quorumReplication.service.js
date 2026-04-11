const logger = require("../../utils/logger");
const predictiveHeat = require("../../infrastructure/cache/predictiveHeat.service");
const consensusMesh = require("./replayConsensusMesh.service");

const HOT_REPLICA_LIMIT = Number(
  process.env.QUORUM_REPLICA_TOP_N || 24
);

const REPLICA_INTERVAL_MS = Number(
  process.env.QUORUM_REPLICA_INTERVAL_MS || 15000
);

const replicaRegistry = new Map();
let replicationWorker = null;

function getHeatScore(entry) {
  return (
    entry?.heatScore ||
    entry?.predictiveHeatScore ||
    entry?.hotness ||
    entry?.priority ||
    0
  );
}

function rankHotTenants(cacheMap) {
  if (!cacheMap?.entries) return [];

  return [...cacheMap.entries()]
    .sort((a, b) => getHeatScore(b[1]) - getHeatScore(a[1]))
    .slice(0, HOT_REPLICA_LIMIT);
}

function chooseReplicaRegions(primaryRegion) {
  const predictiveRegions = predictiveHeat.getTopRegions?.() || [];

  return predictiveRegions
    .filter((region) => region && region !== primaryRegion)
    .slice(0, 2);
}

function promoteWithConsensus({
  tenantId,
  candidate,
  peers = [],
  lineageRegistry,
  replayRegistry,
}) {
  const votes = consensusMesh.requestVotes({
    tenantId,
    candidate,
    peers,
    lineageRegistry,
  });

  if (!consensusMesh.majorityAccepted(votes)) {
    logger.warn(
      `[Patch22] Consensus rejected replay promotion for ${tenantId}`
    );

    for (const peer of peers) {
      const acceptedVote = votes.find(
        (v) => v.region === peer.region && v.accepted
      );

      if (!acceptedVote) {
        consensusMesh.markPeerDegraded(
          peer.region,
          "consensus_rejected"
        );
      }
    }

    return null;
  }

  const winner = consensusMesh.electWinner(votes, candidate);
  if (!winner) return null;

  replayRegistry.set(tenantId, winner);

  for (const peer of peers) {
    consensusMesh.healPeer(peer.region, winner);
  }

  return winner;
}

function syncReplica(tenantId, state) {
  if (!tenantId || !state) return null;

  const current = replicaRegistry.get(tenantId);
  const revision = Number(state.revision || 0);

  // Prevent stale replay resurrection
  if (current && revision < current.revision) {
    return current;
  }

  const primaryRegion = state.region || "primary";
  const peerRegions = chooseReplicaRegions(primaryRegion);

  const candidate = {
    tenantId,
    primaryRegion,
    revision,
    peers: peerRegions,
    replayTs: state.replayTs || Date.now(),
    lineage: state.lineage || null,
    heatScore: getHeatScore(state),
    updatedAt: Date.now(),
  };

  const peers = peerRegions.map((region) => ({
    region,
    healthScore: 100,
  }));

  return (
    promoteWithConsensus({
      tenantId,
      candidate,
      peers,
      lineageRegistry: replicaRegistry,
      replayRegistry: replicaRegistry,
    }) || current
  );
}

function startQuorumReplicationWorker(getCacheMap) {
  if (replicationWorker) {
    logger.warn(
      "[Patch22] quorum replication worker already running"
    );
    return;
  }

  replicationWorker = setInterval(() => {
    try {
      const cacheMap =
        typeof getCacheMap === "function"
          ? getCacheMap()
          : getCacheMap;

      if (!cacheMap?.entries) return;

      const hotTenants = rankHotTenants(cacheMap);

      for (const [tenantId, state] of hotTenants) {
        syncReplica(tenantId, state);
      }
    } catch (error) {
      logger.error(
        "[Patch22] quorum consensus replication worker failure",
        error
      );
    }
  }, REPLICA_INTERVAL_MS);

  logger.info(
    "[Patch22] quorum replication + consensus worker started"
  );
}

function stopQuorumReplicationWorker() {
  if (!replicationWorker) return;

  clearInterval(replicationWorker);
  replicationWorker = null;

  logger.info(
    "[Patch22] quorum replication + consensus worker stopped"
  );
}

function getReplica(tenantId) {
  return replicaRegistry.get(tenantId) || null;
}

function getReplicaPeers(tenantId) {
  return getReplica(tenantId)?.peers || [];
}

module.exports = {
  startQuorumReplicationWorker,
  stopQuorumReplicationWorker,
  syncReplica,
  promoteWithConsensus,
  getReplica,
  getReplicaPeers,
  rankHotTenants,
  replicaRegistry,
};