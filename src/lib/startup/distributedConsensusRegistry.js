'use strict';

// Wave 28 — Distributed startup consensus registry.
// Tracks per-node startup phase state for multi-replica quorum reconciliation.
// All state is in-process; no Redis dependency — safe for single-node dev mode.

const distributedStartupConsensus = {
  nodes: new Map(),
  lineageLedger: [],
  quorumFloor: 2,
  driftEvents: [],
  lastConsensusAt: null,
  // Wave 30 — upgraded from boolean/set-style to renewable lease records:
  // nodeId -> { acquiredAt, renewedAt, expiresAt, leaseEpoch }
  releaseLocks: new Map(),
  staleNodeTtlMs: 30000,
  // Wave 30 — lease mesh constants
  leaseDurationMs: 15000,
  leaseRenewIntervalMs: 5000,
  leaseDriftEvents: [],
};

function publishNodeStartupState(nodeId, state = {}) {
  distributedStartupConsensus.nodes.set(nodeId, {
    ...state,
    updatedAt: Date.now(),
  });
}

function getAllNodeStartupStates() {
  return Array.from(distributedStartupConsensus.nodes.entries()).map(
    ([nodeId, state]) => ({
      nodeId,
      ...state,
    })
  );
}

function recordConsensusDrift(event) {
  distributedStartupConsensus.driftEvents.push({
    ...event,
    ts: Date.now(),
  });
}

// Wave 30 — evict lease entries whose expiresAt has passed.
// Must be called before every reconciliation and readiness probe.
function evictExpiredDistributedLeases() {
  const now = Date.now();

  for (const [nodeId, lease] of distributedStartupConsensus.releaseLocks) {
    if (lease.expiresAt < now) {
      distributedStartupConsensus.releaseLocks.delete(nodeId);

      distributedStartupConsensus.leaseDriftEvents.push({
        nodeId,
        expiredAt: lease.expiresAt,
        evictedAt: now,
      });

      if (distributedStartupConsensus.leaseDriftEvents.length > 500) {
        distributedStartupConsensus.leaseDriftEvents.shift();
      }
    }
  }
}

// Wave 29/30 — idempotent per-node lease acquisition.
// Wave 30 upgrade: grants a renewable lease record instead of a static boolean.
// Returns true on first acquire (no valid unexpired lease from same node);
// returns false if a valid unexpired lease already exists.
function acquireReleaseLock(nodeId) {
  // Evict stale leases before checking ownership.
  evictExpiredDistributedLeases();

  const existing = distributedStartupConsensus.releaseLocks.get(nodeId);

  // Deny if this node already holds a valid unexpired lease.
  if (existing && existing.expiresAt >= Date.now()) {
    return false;
  }

  const now = Date.now();

  distributedStartupConsensus.releaseLocks.set(nodeId, {
    acquiredAt: now,
    renewedAt: now,
    expiresAt: now + distributedStartupConsensus.leaseDurationMs,
    leaseEpoch: now,
  });

  return true;
}

// Wave 29 — evict nodes whose last heartbeat exceeds staleNodeTtlMs.
// Called before every reconciliation pass to prevent crashed replicas
// from poisoning quorum counts indefinitely.
function cleanupStaleConsensusNodes() {
  const now = Date.now();

  for (const [nodeId, state] of distributedStartupConsensus.nodes) {
    if (
      now - state.updatedAt >
      distributedStartupConsensus.staleNodeTtlMs
    ) {
      distributedStartupConsensus.nodes.delete(nodeId);
      distributedStartupConsensus.releaseLocks.delete(nodeId);
    }
  }
}

module.exports = {
  distributedStartupConsensus,
  publishNodeStartupState,
  getAllNodeStartupStates,
  recordConsensusDrift,
  acquireReleaseLock,
  cleanupStaleConsensusNodes,
  evictExpiredDistributedLeases,
};