const cache = require("../../../infrastructure/cache/analyticsCache.service");

const SIGNAL_WEIGHTS = {
  dashboardImpression: 3,
  cacheMiss: 5,
  login: 2,
  cohortPopularity: 4,
  slaWeight: 6,
  invalidationBurst: 5,
  replicaWarmSync: 4,
};

const DECAY_FACTOR = 0.92;
const MIN_DECAY_SCORE = 0.25;
const MAX_SCORE = 1000;
const MAX_BURST_BOOST = 100;
const KEY_PREFIX = "benchmark-hotness";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function buildKey({ tenantId, cohortKey }) {
  return `${KEY_PREFIX}:${tenantId}:${cohortKey}`;
}

async function getHotness({ tenantId, cohortKey }) {
  const key = buildKey({ tenantId, cohortKey });

  return (
    (await cache.get(key)) || {
      tenantId,
      cohortKey,
      score: 0,
      updatedAt: Date.now(),
    }
  );
}

function applyDecay(score, updatedAt) {
  const ageMinutes = (Date.now() - updatedAt) / 60000;
  const decayed = score * Math.pow(DECAY_FACTOR, ageMinutes);

  return decayed < MIN_DECAY_SCORE ? 0 : decayed;
}

async function updateHotness({
  tenantId,
  cohortKey,
  signal,
  amount = 1,
  slaMultiplier = 1,
}) {
  const key = buildKey({ tenantId, cohortKey });

  const current = await getHotness({ tenantId, cohortKey });

  const decayedScore = applyDecay(
    current.score,
    current.updatedAt
  );

  const signalWeight = SIGNAL_WEIGHTS[signal] || 1;

  const rawBoost =
    signalWeight * amount * slaMultiplier;

  const boundedBoost = clamp(
    rawBoost,
    0,
    MAX_BURST_BOOST
  );

  const next = {
    tenantId,
    cohortKey,
    score: clamp(
      decayedScore + boundedBoost,
      0,
      MAX_SCORE
    ),
    updatedAt: Date.now(),
  };

  await cache.set(
    key,
    next,
    cache.DEFAULT_TTL.analytics || 900
  );

  return next;
}

async function getTopHotBenchmarks(limit = 20) {
  let keys = [];

  try {
    keys = await cache.keys(`${KEY_PREFIX}:*`);
  } catch (error) {
    // degraded node-cache fallback safety
    keys = cache.listKeys
      ? await cache.listKeys(KEY_PREFIX)
      : [];
  }

  const rows = await Promise.all(
    keys.map((key) => cache.get(key))
  );

  return rows
    .filter(Boolean)
    .map((row) => ({
      ...row,
      score: applyDecay(row.score, row.updatedAt),
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

module.exports = {
  updateHotness,
  getTopHotBenchmarks,
  getHotness,
};