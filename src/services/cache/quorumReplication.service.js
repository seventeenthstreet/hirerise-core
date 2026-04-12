const logger = require("../../utils/logger");
const predictiveHeat = require("../../infrastructure/cache/predictiveHeat.service");
const consensusMesh = require("./replayConsensusMesh.service");
const driftAnomaly = require("./consensusDriftAnomaly.service");
const predictiveSplitBrain = require("./predictiveSplitBrain.service");

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

function buildRevisionSpread(votes, fallbackRevision) {
  const revisions = votes
    .map((v) => Number(v?.revision))
    .filter((v) => Number.isFinite(v));

  if (!revisions.length) {
    return {
      min: fallbackRevision,
      max: fallbackRevision,
      spread: 0,
    };
  }

  const min = Math.min(...revisions);
  const max = Math.max(...revisions);

  return {
    min,
    max,
    spread: max - min,
  };
}

function getAverageConfidence(votes = []) {
  if (!votes.length) return 0;

  const total = votes.reduce(
    (sum, vote) => sum + Number(vote.confidence || 0),
    0
  );

  return Number((total / votes.length).toFixed(4));
}

function promoteWithConsensus({
  tenantId,
  candidate,
  peers = [],
  lineageRegistry,
  replayRegistry,
}) {
  const primaryRegion = candidate?.primaryRegion || "primary";

  // Patch 23 — block unstable region promotion
  if (driftAnomaly.isRegionIsolated(primaryRegion)) {
    logger.warn(
      `[Patch23] Promotion blocked for unstable isolated region ${primaryRegion}`
    );
    return null;
  }

  // Patch 24 — predictive split-brain dampening
  if (predictiveSplitBrain.isPromotionDampened(tenantId)) {
    logger.warn(
      `[Patch24] Promotion dampened due to predictive split-brain risk tenant=${tenantId}`
    );
    return null;
  }

  const votes = consensusMesh.requestVotes({
    tenantId,
    candidate,
    peers,
    lineageRegistry,
  });

  const rejectedPeers = [];

  // Patch 25 — weighted majority acceptance
  const consensusAccepted = consensusMesh.majorityAccepted(
    votes,
    tenantId
  );

  if (!consensusAccepted) {
    logger.warn(
      `[Patch25] Weighted consensus rejected replay promotion for ${tenantId}`
    );

    for (const peer of peers) {
      const acceptedVote = votes.find(
        (v) => v.region === peer.region && v.accepted
      );

      if (!acceptedVote) {
        rejectedPeers.push(peer.region);
        consensusMesh.markPeerDegraded(
          peer.region,
          "weighted_consensus_rejected"
        );
      }
    }
  }

  const revisionSpreadState = buildRevisionSpread(
    votes,
    Number(candidate?.revision || 0)
  );

  const averageConfidence = getAverageConfidence(votes);

  // Patch 24 — predictive prevention telemetry
  const splitBrainState = predictiveSplitBrain.recordSignal({
    tenantId,
    replaySpread: revisionSpreadState.spread,
    latencySpread: rejectedPeers.length * 25,
    degradedPeers: rejectedPeers.length,
  });

  // Patch 25 — confidence-aware early healing
  if (
    splitBrainState.earlyHealingRecommended ||
    averageConfidence < 0.55
  ) {
    logger.warn(
      `[Patch25] Confidence-aware healing tenant=${tenantId} confidence=${averageConfidence}`
    );

    for (const peer of peers) {
      consensusMesh.healPeer(peer.region, candidate);
    }
  }

  // Patch 23 — anomaly telemetry feed
  const anomalyState = driftAnomaly.analyzeSnapshot(
    {
      region: primaryRegion,
      votes: {
        total: Math.max(votes.length, 1),
        disagree: votes.filter((v) => !v.accepted).length,
        averageConfidence,
      },
      revisions: revisionSpreadState,
      peerState: {
        degraded: rejectedPeers.length > 0,
      },
    },
    {
      healPeerMesh: (region, severity) => {
        logger.warn(
          `[Patch23] Self-healing quorum mesh region=${region} severity=${severity}`
        );

        for (const peer of peers) {
          consensusMesh.healPeer(peer.region, candidate);
        }
      },
    }
  );

  logger.info(
    `[Patch23] Drift severity tenant=${tenantId} severity=${anomalyState.severity}`
  );

  logger.info(
    `[Patch24] Split-brain risk tenant=${tenantId} risk=${splitBrainState.risk}`
  );

  logger.info(
    `[Patch25] Average quorum confidence tenant=${tenantId} confidence=${averageConfidence}`
  );

  if (!consensusAccepted) {
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