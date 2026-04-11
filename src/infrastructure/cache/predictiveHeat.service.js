const cache = require("./analyticsCache.service");

const WINDOW_15M_MS = 15 * 60 * 1000;
const WINDOW_1H_MS = 60 * 60 * 60 * 1000;
const FORECAST_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const FORECAST_CAP = 40;

const PATCH8 = {
  replayRegistry: new Map(),
  retryLoopTracker: new Map(),
  percentileStorms: new Map(),
  chiFloodTracker: new Map(),
  burstScaleTracker: new Map(),
  revisionTracker: new Map(),
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

// ============================================================
// Patch 8 internals
// ============================================================

function pruneStaleReplayRegistry(maxAgeMs = WINDOW_15M_MS) {
  const cutoff = Date.now() - maxAgeMs;

  for (const [tenantId, meta] of PATCH8.replayRegistry.entries()) {
    if (!meta?.ts || meta.ts < cutoff) {
      PATCH8.replayRegistry.delete(tenantId);
    }
  }
}

function correctRevisionDrift(tenantId, incomingRevision) {
  const current = PATCH8.revisionTracker.get(tenantId) || 0;
  const drift = incomingRevision - current;

  let corrected = incomingRevision;

  if (Math.abs(drift) > 1) {
    corrected = current + Math.sign(drift);
  }

  PATCH8.revisionTracker.set(tenantId, corrected);
  return corrected;
}

function suppressRetryLoopAnomaly(key, ttlMs = 120000) {
  const now = Date.now();
  const state = PATCH8.retryLoopTracker.get(key) || {
    count: 0,
    ts: now,
  };

  if (now - state.ts > ttlMs) {
    state.count = 0;
    state.ts = now;
  }

  state.count += 1;
  PATCH8.retryLoopTracker.set(key, state);

  return state.count > 5;
}

function dampenPercentileMissStorm(tenantId) {
  const now = Date.now();
  const state = PATCH8.percentileStorms.get(tenantId) || {
    count: 0,
    ts: now,
  };

  if (now - state.ts > 60000) {
    state.count = 0;
    state.ts = now;
  }

  state.count += 1;
  PATCH8.percentileStorms.set(tenantId, state);

  return Math.min(1, 10 / state.count);
}

function smoothChiBatchFlood(tenantId, score) {
  const prev = PATCH8.chiFloodTracker.get(tenantId) || score;
  const smoothed = prev * 0.7 + score * 0.3;

  PATCH8.chiFloodTracker.set(tenantId, smoothed);
  return smoothed;
}

function normalizeLowVolumeFairness(score, tenantVolume) {
  if (tenantVolume >= 50) return score;

  const fairnessBoost = 1 + (50 - tenantVolume) / 100;
  return score * fairnessBoost;
}

function rankReplayPriority({
  confidence = 0,
  heat = 0,
  replayMemory = 0,
  tenantVolume = 0,
  stormDampener = 1,
}) {
  let priority =
    confidence * 0.35 +
    heat * 0.35 +
    replayMemory * 0.2 +
    stormDampener * 0.1;

  priority = normalizeLowVolumeFairness(priority, tenantVolume);

  return Math.max(1, Math.round(priority));
}

function suppressScaleOutBurst(tenantId) {
  const now = Date.now();
  const existing = PATCH8.burstScaleTracker.get(tenantId) || [];

  const recent = existing.filter((ts) => now - ts < 30000);
  recent.push(now);

  PATCH8.burstScaleTracker.set(tenantId, recent);

  return recent.length > 10;
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

  if (suppressScaleOutBurst(tenantId)) {
    return;
  }

  const retryBlocked = suppressRetryLoopAnomaly(
    `${tenantId}:${signalType}`
  );

  if (retryBlocked) {
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
  const adjustedWeight = Math.max(
    1,
    Math.round(weight * dampener)
  );

  const updates = [
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
  ];

  await Promise.allSettled(updates);

  PATCH8.replayRegistry.set(tenantId, {
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

  const [heat15m, heat1h, replayMemory] = await Promise.all([
    cache.get(buildKey("heat15m", tenantId, slot15)),
    cache.get(buildKey("heat1h", tenantId, slot60)),
    cache.get(
      buildKey(
        "forecast",
        tenantId,
        `${weekday}:${slot15}:${signalType}`
      )
    ),
  ]);

  const heatScore =
    Number(heat15m || 0) * 1.4 +
    Number(heat1h || 0) * 0.8;

  const replayScore = Number(replayMemory || 0) * 1.2;
  const smoothedReplay = smoothChiBatchFlood(
    tenantId,
    replayScore
  );

  const priority = rankReplayPriority({
    confidence: heatScore,
    heat: heatScore,
    replayMemory: smoothedReplay,
    tenantVolume,
    stormDampener: dampenPercentileMissStorm(tenantId),
  });

  return Math.min(priority, FORECAST_CAP);
}

module.exports = {
  recordHeat,
  getPredictiveBoost,
};