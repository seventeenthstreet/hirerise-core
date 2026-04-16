'use strict';

// Wave 29 — Distributed quorum reconciliation engine: hard release arbitration.
// Enforces quorum floor, split-brain lock denial, and stale node eviction.
// Single-node dev fallback preserves local boot safety without Redis dependency.

const {
  distributedStartupConsensus,
  getAllNodeStartupStates,
  recordConsensusDrift,
  acquireReleaseLock,
  cleanupStaleConsensusNodes,
  evictExpiredDistributedLeases,
} = require('./distributedConsensusRegistry');

function reconcileDistributedStartupQuorum(localState) {
  cleanupStaleConsensusNodes();

  // Wave 30 — evict crash-expired leases before arbitration
  evictExpiredDistributedLeases();

  const nodes = getAllNodeStartupStates();

  const quorumReadyNodes = nodes.filter(
    (node) => node.isReleased === true
  );

  const divergentNodes = nodes.filter(
    (node) =>
      JSON.stringify(node.completedPhases || []) !==
      JSON.stringify(localState.completedPhases || [])
  );

  const singleNodeSafe =
    nodes.length <= 1 &&
    process.env.NODE_ENV !== 'production';

  const consensusReached =
    singleNodeSafe ||
    quorumReadyNodes.length >=
      distributedStartupConsensus.quorumFloor;

  // Wave 30 — deny grant if another node holds a valid unexpired lease
  const now = Date.now();
  const conflictingLease = Array.from(
    distributedStartupConsensus.releaseLocks.entries()
  ).find(
    ([ownerId, lease]) =>
      ownerId !== localState.nodeId && lease.expiresAt >= now
  );

  const lockGranted =
    consensusReached &&
    divergentNodes.length === 0 &&
    !conflictingLease &&
    acquireReleaseLock(localState.nodeId);

  if (divergentNodes.length > 0) {
    recordConsensusDrift({
      localNode: localState.nodeId,
      divergentNodes: divergentNodes.map((n) => n.nodeId),
      reason: 'split_brain_lock_denied',
    });
  }

  distributedStartupConsensus.lastConsensusAt = Date.now();

  return {
    consensusReached,
    quorumReadyNodes: quorumReadyNodes.length,
    divergentNodes: divergentNodes.length,
    lockGranted,
    singleNodeSafe,
    conflictingLease: conflictingLease
      ? { ownerId: conflictingLease[0], expiresAt: conflictingLease[1].expiresAt }
      : null,
  };
}

module.exports = { reconcileDistributedStartupQuorum };