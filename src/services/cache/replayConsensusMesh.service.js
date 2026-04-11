const logger = require("../../utils/logger");

const peerHealth = new Map();
const peerVotes = new Map();
const degradedPeers = new Map();

function now() {
  return Date.now();
}

function getHealthyPeers(peers = []) {
  if (!Array.isArray(peers)) return [];

  return peers.filter((peer) => {
    if (!peer?.region) return false;

    const state = peerHealth.get(peer.region);
    return !state || state.healthy !== false;
  });
}

function validateLineage(candidate, lineageRegistry) {
  if (!candidate) return false;

  const tenantId = candidate.tenantId;
  const existing = lineageRegistry?.get?.(tenantId);

  // First promotion is valid
  if (!existing) return true;

  const candidateRevision = Number(candidate.revision || 0);
  const existingRevision = Number(existing.revision || 0);

  // Prevent stale replay resurrection
  if (candidateRevision < existingRevision) {
    return false;
  }

  // Parent lineage must strictly match previous winner
  if (
    candidate.parentRevision !== undefined &&
    candidate.parentRevision !== null &&
    Number(candidate.parentRevision) !== existingRevision
  ) {
    return false;
  }

  return true;
}

function requestVotes({
  tenantId,
  candidate,
  peers = [],
  lineageRegistry,
}) {
  if (!tenantId || !candidate) return [];

  const healthyPeers = getHealthyPeers(peers);
  const votes = [];

  for (const peer of healthyPeers) {
    const accepted = validateLineage(candidate, lineageRegistry);

    votes.push({
      region: peer.region,
      accepted,
      revision: Number(candidate.revision || 0),
      ts: now(),
      score: Number(peer.healthScore || 0),
    });
  }

  peerVotes.set(tenantId, votes);
  return votes;
}

function majorityAccepted(votes = []) {
  if (!votes.length) return false;

  const accepted = votes.filter((v) => v.accepted).length;
  const quorum = Math.floor(votes.length / 2) + 1;

  return accepted >= quorum;
}

function electWinner(votes = [], candidate) {
  if (!candidate || !votes.length) return null;

  const healthiest = [...votes]
    .filter((v) => v.accepted)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.ts - a.ts;
    })[0];

  if (!healthiest) return null;

  return {
    ...candidate,
    promotedRegion: healthiest.region,
    consensusTs: now(),
  };
}

function arbitrateConflict(local, remote) {
  if (!local) return remote || null;
  if (!remote) return local || null;

  const localRevision = Number(local.revision || 0);
  const remoteRevision = Number(remote.revision || 0);

  if (remoteRevision > localRevision) return remote;
  if (localRevision > remoteRevision) return local;

  return Number(remote.ts || 0) > Number(local.ts || 0)
    ? remote
    : local;
}

function markPeerDegraded(region, reason = "consensus_miss") {
  if (!region) return;

  degradedPeers.set(region, {
    region,
    reason,
    ts: now(),
  });

  peerHealth.set(region, {
    healthy: false,
    degradedReason: reason,
    ts: now(),
  });
}

function healPeer(region, winnerState) {
  if (!region) return;

  degradedPeers.delete(region);

  peerHealth.set(region, {
    healthy: true,
    lastRecoveryTs: now(),
    syncedRevision: winnerState?.revision ?? null,
  });
}

function getConsensusState(tenantId) {
  return {
    tenantId,
    votes: peerVotes.get(tenantId) || [],
    degradedPeers: [...degradedPeers.values()],
    peerHealth: [...peerHealth.entries()].map(([region, state]) => ({
      region,
      ...state,
    })),
  };
}

function shutdown() {
  const voteCount = peerVotes.size;
  const degradedCount = degradedPeers.size;
  const healthCount = peerHealth.size;

  peerVotes.clear();
  degradedPeers.clear();
  peerHealth.clear();

  logger.info(
    `[Patch22] consensus replay mesh shutdown complete | votes=${voteCount} degraded=${degradedCount} health=${healthCount}`
  );
}

module.exports = {
  requestVotes,
  majorityAccepted,
  electWinner,
  arbitrateConflict,
  markPeerDegraded,
  healPeer,
  getConsensusState,
  shutdown,
};