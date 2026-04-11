const cache = require("./analyticsCache.service");
const logger = require("../../utils/logger");

const PREFIX = "predictive:consensus";
const DEFAULT_TTL = 60 * 20; // 20m
const LOCK_TTL = 45;
const QUORUM_WINDOW = 4;

function key(type, tenantId) {
  return `${PREFIX}:${type}:${tenantId}`;
}

function lockKey(type, tenantId) {
  return `${PREFIX}:lock:${type}:${tenantId}`;
}

function podId() {
  return process.env.K_REVISION || process.env.HOSTNAME || `pod-${process.pid}`;
}

async function publishHeatVote({
  tenantId,
  signal,
  confidence = 1,
  ttl = DEFAULT_TTL,
}) {
  const redis = cache.redis;

  const payload = {
    tenantId,
    signal,
    confidence,
    podId: podId(),
    ts: Date.now(),
  };

  if (!redis?.isReady) {
    return {
      degraded: true,
      accepted: true,
      quorum: 1,
      avgConfidence: confidence,
      consensus: true,
    };
  }

  const k = key(signal, tenantId);

  await redis.hSet(k, payload.podId, JSON.stringify(payload));
  await redis.expire(k, ttl);

  const votes = await redis.hVals(k);

  const parsed = votes
    .map((v) => {
      try {
        return JSON.parse(v);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((v) => Date.now() - v.ts < ttl * 1000);

  const quorum = parsed.length;

  const avgConfidence =
    parsed.reduce((sum, v) => sum + (v.confidence || 0), 0) /
    Math.max(quorum, 1);

  return {
    accepted: true,
    quorum,
    avgConfidence,
    consensus: quorum >= 2,
  };
}

async function acquireWarmOwnership({ tenantId, signal }) {
  const redis = cache.redis;
  const owner = podId();

  if (!redis?.isReady) {
    return { acquired: true, degraded: true, owner };
  }

  const result = await redis.set(
    lockKey(signal, tenantId),
    owner,
    { NX: true, EX: LOCK_TTL }
  );

  return {
    acquired: result === "OK",
    owner,
  };
}

async function releaseWarmOwnership({ tenantId, signal }) {
  const redis = cache.redis;
  if (!redis?.isReady) return;

  await redis.del(lockKey(signal, tenantId));
}

async function getConsensusSnapshot({ tenantId, signal }) {
  const redis = cache.redis;

  if (!redis?.isReady) {
    return { degraded: true, quorum: 0, confidence: 0 };
  }

  const values = await redis.hVals(key(signal, tenantId));
  const quorum = values.length;

  return {
    quorum,
    confidence: Math.min(1, quorum / QUORUM_WINDOW),
  };
}

module.exports = {
  publishHeatVote,
  acquireWarmOwnership,
  releaseWarmOwnership,
  getConsensusSnapshot,
};
