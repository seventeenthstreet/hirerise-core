const cache = require("./analyticsCache.service");

const WINDOW_15M_MS = 15 * 60 * 1000;
const WINDOW_1H_MS = 60 * 60 * 1000;
const FORECAST_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const FORECAST_CAP = 40;
const REBALANCE_INTERVAL_MS = 60 * 1000;
const LEARNING_INTERVAL_MS = 45 * 1000;
const FEDERATION_INTERVAL_MS = 90 * 1000;
const HOT_KEY_THRESHOLD = 100;
const REPLICA_SYNC_TTL_MS = 10 * 60 * 1000;
const FEDERATION_TTL_MS = 12 * 60 * 60 * 1000;

const PATCH11 = {
  replayRegistry: new Map(),
  retryLoopTracker: new Map(),
  percentileStorms: new Map(),
  chiFloodTracker: new Map(),
  burstScaleTracker: new Map(),
  revisionTracker: new Map(),
  shardPressure: new Map(),
  orphanReplay: new Map(),
  laneEntropy: new Map(),

  // Patch 10 intelligence mesh
  replayLaneLearning: new Map(),
  burstOutcomeMemory: new Map(),
  replicaIntelligence: new Map(),

  // Patch 11 federation
  federationMemory: new Map(),
  federationReplicaSync: new Map(),
};

function getTimeSlot(date = new Date(), bucketMinutes = 15) {
  const mins = date.getHours() * 60 + date.getMinutes();
  return Math.floor(mins / bucketMinutes);
}

function getWeekday(date = new Date()) {
  return date.getDay();
}

function buildKey(type, tenantId, suffix) {
  return `${type}:${tenantId}:${suffix}`;
}

function getLearningKey(tenantId, signalType) {
  return `${tenantId}:${signalType}`;
}

function getFederationClusterKey(signalType, tenantVolume) {
  const band =
    tenantVolume >= 100 ? "high" :
    tenantVolume >= 25 ? "mid" : "low";

  return `${signalType}:${band}`;
}

function getSimilarityWeight(sourceVolume, targetVolume) {
  const diff = Math.abs(sourceVolume - targetVolume);

  if (diff <= 10) return 1;
  if (diff <= 50) return 0.7;
  if (diff <= 100) return 0.4;
  return 0.2;
}

async function safeIncrement(key, amount = 1, ttlMs = WINDOW_1H_MS) {
  const redis = cache.redis;

  if (redis?.isReady) {
    const next = await redis.incrBy(key, amount);
    await redis.pexpire(key, ttlMs);
    return next;
  }

  const existing = await cache.get(key);
  const next = Number(existing || 0) + amount;

  await cache.set(key, next, Math.ceil(ttlMs / 1000));
  return next;
}

async function safeSet(key, value, ttlMs) {
  try {
    await cache.set(
      key,
      value,
      Math.ceil(ttlMs / 1000)
    );
  } catch (error) {
    return null;
  }
}

// ============================================================
// Patch 8 + 9 healing
// ============================================================

function pruneStaleReplayRegistry(maxAgeMs = WINDOW_15M_MS) {
  const cutoff = Date.now() - maxAgeMs;

  for (const [tenantId, meta] of PATCH11.replayRegistry.entries()) {
    if (!meta?.ts || meta.ts < cutoff) {
      PATCH11.orphanReplay.set(tenantId, meta);
      PATCH11.replayRegistry.delete(tenantId);
    }
  }
}

function recoverOrphanReplay(tenantId) {
  const orphan = PATCH11.orphanReplay.get(tenantId);
  if (!orphan) return null;

  PATCH11.replayRegistry.set(tenantId, {
    ...orphan,
    recovered: true,
    ts: Date.now(),
  });

  PATCH11.orphanReplay.delete(tenantId);
  return true;
}

function correctRevisionDrift(tenantId, incomingRevision) {
  const current = PATCH11.revisionTracker.get(tenantId) || 0;
  const drift = incomingRevision - current;

  let corrected = incomingRevision;

  if (Math.abs(drift) > 1) {
    corrected = current + Math.sign(drift);
  }

  PATCH11.revisionTracker.set(tenantId, corrected);
  return corrected;
}

function suppressRetryLoopAnomaly(key, ttlMs = 120000) {
  const now = Date.now();
  const state = PATCH11.retryLoopTracker.get(key) || {
    count: 0,
    ts: now,
  };

  if (now - state.ts > ttlMs) {
    state.count = 0;
    state.ts = now;
  }

  state.count += 1;
  PATCH11.retryLoopTracker.set(key, state);

  return state.count > 5;
}

function dampenPercentileMissStorm(tenantId) {
  const now = Date.now();
  const state = PATCH11.percentileStorms.get(tenantId) || {
    count: 0,
    ts: now,
  };

  if (now - state.ts > 60000) {
    state.count = 0;
    state.ts = now;
  }

  state.count += 1;
  PATCH11.percentileStorms.set(tenantId, state);

  return Math.min(1, 10 / state.count);
}

function smoothChiBatchFlood(tenantId, score) {
  const prev = PATCH11.chiFloodTracker.get(tenantId) || score;
  const smoothed = prev * 0.7 + score * 0.3;

  PATCH11.chiFloodTracker.set(tenantId, smoothed);
  return smoothed;
}

function normalizeLowVolumeFairness(score, tenantVolume) {
  if (tenantVolume >= 50) return score;
  return score * (1 + (50 - tenantVolume) / 100);
}

function trackShardPressure(tenantId, score) {
  const current = PATCH11.shardPressure.get(tenantId) || 0;
  const next = current * 0.8 + score * 0.2;
  PATCH11.shardPressure.set(tenantId, next);
  return next;
}

function rebalanceHotShard(tenantId, score) {
  const pressure = trackShardPressure(tenantId, score);
  if (pressure < HOT_KEY_THRESHOLD) return score;
  return Math.round(score * 0.75);
}

function rebalanceLaneEntropy(tenantId, score) {
  const current = PATCH11.laneEntropy.get(tenantId) || score;
  const entropy = current * 0.6 + score * 0.4;

  PATCH11.laneEntropy.set(tenantId, entropy);

  if (entropy > HOT_KEY_THRESHOLD) {
    return Math.round(score * 0.8);
  }

  return score;
}

function suppressScaleOutBurst(tenantId) {
  const now = Date.now();
  const existing = PATCH11.burstScaleTracker.get(tenantId) || [];

  const recent = existing.filter((ts) => now - ts < 30000);
  recent.push(now);

  PATCH11.burstScaleTracker.set(tenantId, recent);

  return recent.length > 10;
}

// ============================================================
// Patch 10 + 11 learning + federation
// ============================================================

function getLaneLearningProfile(tenantId, signalType) {
  const key = getLearningKey(tenantId, signalType);

  return (
    PATCH11.replayLaneLearning.get(key) || {
      reward: 0,
      penalty: 0,
      confidence: 0.5,
      wins: 0,
      losses: 0,
      samples: 0,
      ts: Date.now(),
    }
  );
}

function reinforceReplayLane({
  tenantId,
  signalType,
  success = true,
  burstScore = 0,
}) {
  const key = getLearningKey(tenantId, signalType);
  const profile = getLaneLearningProfile(tenantId, signalType);

  profile.samples += 1;
  profile.ts = Date.now();

  if (success) {
    profile.reward += 1 + burstScore;
    profile.wins += 1;
    profile.confidence = Math.min(0.99, profile.confidence + 0.05);
  } else {
    profile.penalty += 1;
    profile.losses += 1;
    profile.confidence = Math.max(0.05, profile.confidence - 0.08);
  }

  PATCH11.replayLaneLearning.set(key, profile);
  PATCH11.burstOutcomeMemory.set(key, {
    success,
    burstScore,
    ts: Date.now(),
  });

  return profile;
}

async function publishFederationLearning({
  signalType,
  confidence,
  tenantVolume,
}) {
  const clusterKey = getFederationClusterKey(
    signalType,
    tenantVolume
  );

  const snapshot = {
    confidence,
    tenantVolume,
    ts: Date.now(),
  };

  PATCH11.federationMemory.set(clusterKey, snapshot);

  await safeSet(
    `federation:${clusterKey}`,
    snapshot,
    FEDERATION_TTL_MS
  );
}

async function getFederatedBoost(signalType, tenantVolume) {
  const clusterKey = getFederationClusterKey(
    signalType,
    tenantVolume
  );

  const snapshot =
    PATCH11.federationMemory.get(clusterKey) ||
    (await cache.get(`federation:${clusterKey}`));

  if (!snapshot) return 0;

  const similarity = getSimilarityWeight(
    snapshot.tenantVolume,
    tenantVolume
  );

  return Math.round(snapshot.confidence * 8 * similarity);
}

function applyAdaptiveLearningBoost(
  tenantId,
  signalType,
  baseScore
) {
  const profile = getLaneLearningProfile(
    tenantId,
    signalType
  );

  const reinforcementBoost =
    profile.reward * 0.08 - profile.penalty * 0.12;

  const confidenceBoost = profile.confidence * 10;

  return Math.max(
    1,
    Math.round(baseScore + reinforcementBoost + confidenceBoost)
  );
}

async function syncReplicaIntelligence() {
  const replicaId = process.env.K_REVISION || "local-dev";

  const snapshot = {
    replicaId,
    active: true,
    learningProfiles: PATCH11.replayLaneLearning.size,
    ts: Date.now(),
  };

  PATCH11.replicaIntelligence.set(replicaId, snapshot);

  await safeSet(
    `predictive_mesh:${replicaId}`,
    snapshot,
    REPLICA_SYNC_TTL_MS
  );
}

async function syncFederationReplica() {
  const replicaId = process.env.K_REVISION || "local-dev";

  const snapshot = {
    replicaId,
    clusters: PATCH11.federationMemory.size,
    ts: Date.now(),
  };

  PATCH11.federationReplicaSync.set(replicaId, snapshot);

  await safeSet(
    `federation_sync:${replicaId}`,
    snapshot,
    REPLICA_SYNC_TTL_MS
  );
}

// ============================================================
// Core predictive logic
// ============================================================

async function recordHeat({
  tenantId,
  signalType,
  weight = 1,
  revision = 1,
}) {
  if (!tenantId || !signalType) return;

  pruneStaleReplayRegistry();
  recoverOrphanReplay(tenantId);

  if (suppressScaleOutBurst(tenantId)) return;

  const retryBlocked = suppressRetryLoopAnomaly(
    `${tenantId}:${signalType}`
  );

  if (retryBlocked) {
    reinforceReplayLane({
      tenantId,
      signalType,
      success: false,
    });
    return;
  }

  const correctedRevision = correctRevisionDrift(
    tenantId,
    revision
  );

  const now = new Date();
  const slot15 = getTimeSlot(now, 15);
  const slot60 = getTimeSlot(now, 60);
  const weekday = getWeekday(now);

  const dampener = dampenPercentileMissStorm(tenantId);

  let adjustedWeight = Math.max(
    1,
    Math.round(weight * dampener)
  );

  adjustedWeight = rebalanceHotShard(
    tenantId,
    adjustedWeight
  );

  const learningProfile = reinforceReplayLane({
    tenantId,
    signalType,
    success: true,
    burstScore: adjustedWeight,
  });

  await publishFederationLearning({
    signalType,
    confidence: learningProfile.confidence,
    tenantVolume: adjustedWeight,
  });

  adjustedWeight = Math.max(
    adjustedWeight,
    Math.round(adjustedWeight * learningProfile.confidence)
  );

  await Promise.allSettled([
    safeIncrement(
      buildKey("heat15m", tenantId, slot15),
      adjustedWeight,
      WINDOW_15M_MS
    ),
    safeIncrement(
      buildKey("heat1h", tenantId, slot60),
      adjustedWeight,
      WINDOW_1H_MS
    ),
    safeIncrement(
      buildKey(
        "forecast",
        tenantId,
        `${weekday}:${slot15}:${signalType}`
      ),
      adjustedWeight,
      FORECAST_TTL_MS
    ),
  ]);

  PATCH11.replayRegistry.set(tenantId, {
    signalType,
    revision: correctedRevision,
    ts: Date.now(),
  });
}

async function getPredictiveBoost({
  tenantId,
  signalType,
  tenantVolume = 10,
}) {
  if (!tenantId || !signalType) return 0;

  const now = new Date();
  const slot15 = getTimeSlot(now, 15);
  const slot60 = getTimeSlot(now, 60);
  const weekday = getWeekday(now);

  const [heat15m, heat1h, replayMemory, federatedBoost] =
    await Promise.all([
      cache.get(buildKey("heat15m", tenantId, slot15)),
      cache.get(buildKey("heat1h", tenantId, slot60)),
      cache.get(
        buildKey(
          "forecast",
          tenantId,
          `${weekday}:${slot15}:${signalType}`
        )
      ),
      getFederatedBoost(signalType, tenantVolume),
    ]);

  const heatScore =
    Number(heat15m || 0) * 1.4 +
    Number(heat1h || 0) * 0.8;

  const replayScore = Number(replayMemory || 0) * 1.2;

  const smoothedReplay = smoothChiBatchFlood(
    tenantId,
    replayScore
  );

  let priority =
    heatScore * 0.35 +
    heatScore * 0.35 +
    smoothedReplay * 0.2 +
    dampenPercentileMissStorm(tenantId) * 0.1;

  priority += federatedBoost;

  priority = normalizeLowVolumeFairness(
    priority,
    tenantVolume
  );

  priority = rebalanceHotShard(tenantId, priority);
  priority = rebalanceLaneEntropy(tenantId, priority);

  priority = applyAdaptiveLearningBoost(
    tenantId,
    signalType,
    priority
  );

  return Math.min(priority, FORECAST_CAP);
}

// ============================================================
// Lifecycle workers
// ============================================================

function startPredictiveTopologyWorker() {
  if (global.__HIRERISE_PATCH11_TOPOLOGY_WORKER__) {
    clearInterval(global.__HIRERISE_PATCH11_TOPOLOGY_WORKER__);
  }

  global.__HIRERISE_PATCH11_TOPOLOGY_WORKER__ = setInterval(() => {
    pruneStaleReplayRegistry();

    for (const [tenantId, pressure] of PATCH11.shardPressure.entries()) {
      if (pressure < HOT_KEY_THRESHOLD * 0.4) {
        PATCH11.shardPressure.delete(tenantId);
      }
    }
  }, REBALANCE_INTERVAL_MS);
}

function stopPredictiveTopologyWorker() {
  if (global.__HIRERISE_PATCH11_TOPOLOGY_WORKER__) {
    clearInterval(global.__HIRERISE_PATCH11_TOPOLOGY_WORKER__);
  }
}

function startLearningMeshWorker() {
  if (global.__HIRERISE_PATCH11_LEARNING_WORKER__) {
    clearInterval(global.__HIRERISE_PATCH11_LEARNING_WORKER__);
  }

  global.__HIRERISE_PATCH11_LEARNING_WORKER__ = setInterval(() => {
    syncReplicaIntelligence().catch(() => null);
  }, LEARNING_INTERVAL_MS);
}

function stopLearningMeshWorker() {
  if (global.__HIRERISE_PATCH11_LEARNING_WORKER__) {
    clearInterval(global.__HIRERISE_PATCH11_LEARNING_WORKER__);
  }
}

function startFederationWorker() {
  if (global.__HIRERISE_PATCH11_FEDERATION_WORKER__) {
    clearInterval(global.__HIRERISE_PATCH11_FEDERATION_WORKER__);
  }

  global.__HIRERISE_PATCH11_FEDERATION_WORKER__ = setInterval(() => {
    syncFederationReplica().catch(() => null);
  }, FEDERATION_INTERVAL_MS);
}

function stopFederationWorker() {
  if (global.__HIRERISE_PATCH11_FEDERATION_WORKER__) {
    clearInterval(global.__HIRERISE_PATCH11_FEDERATION_WORKER__);
  }
}

module.exports = {
  recordHeat,
  getPredictiveBoost,
  startPredictiveTopologyWorker,
  stopPredictiveTopologyWorker,
  startLearningMeshWorker,
  stopLearningMeshWorker,
  startFederationWorker,
  stopFederationWorker,
};