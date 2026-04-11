const crypto = require("crypto");
const redis = require("../../config/redis"); // preserve existing Redis adapter

const DEFAULT_TTL = {
  percentile: 300,   // 5 min
  trend: 180,        // 3 min
  benchmark: 900,    // 15 min
  dashboard: 120,    // 2 min
  cohort: 600        // 10 min
};

function stableHash(payload = {}) {
  return crypto
    .createHash("sha1")
    .update(JSON.stringify(payload))
    .digest("hex");
}

function buildKey(namespace, tenantId, payload = {}) {
  const hash = stableHash(payload);
  return `analytics:${tenantId}:${namespace}:${hash}`;
}

async function getOrSet({
  namespace,
  tenantId,
  payload,
  ttl,
  queryFn
}) {
  const key = buildKey(namespace, tenantId, payload);

  const cached = await redis.get(key);
  if (cached) {
    return JSON.parse(cached);
  }

  const fresh = await queryFn();

  // write only successful payloads
  if (fresh !== null && fresh !== undefined) {
    await redis.set(key, JSON.stringify(fresh), "EX", ttl);
  }

  return fresh;
}

async function invalidatePattern(pattern) {
  const keys = await redis.keys(pattern);
  if (!keys.length) return 0;
  await redis.del(...keys);
  return keys.length;
}

module.exports = {
  DEFAULT_TTL,
  buildKey,
  getOrSet,
  invalidatePattern
};
