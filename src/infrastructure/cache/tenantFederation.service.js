const cache = require("./analyticsCache.service");

const FEDERATION_TTL_MS = 12 * 60 * 60 * 1000;
const FEDERATION_NS = "tenant_federation";

const federationMemory = new Map();

function getFederationKey(clusterKey) {
  return `${FEDERATION_NS}:${clusterKey}`;
}

function buildClusterKey({ signalType, tenantVolume }) {
  const volumeBand =
    tenantVolume >= 100 ? "high" :
    tenantVolume >= 25 ? "mid" : "low";

  return `${signalType}:${volumeBand}`;
}

async function publishTenantLearning({
  tenantId,
  signalType,
  confidence,
  tenantVolume,
}) {
  const clusterKey = buildClusterKey({
    signalType,
    tenantVolume,
  });

  const snapshot = {
    clusterKey,
    confidence,
    tenantVolume,
    ts: Date.now(),
  };

  federationMemory.set(clusterKey, snapshot);

  await cache.set(
    getFederationKey(clusterKey),
    snapshot,
    Math.ceil(FEDERATION_TTL_MS / 1000)
  );

  return snapshot;
}

async function getFederatedBoost({
  signalType,
  tenantVolume,
}) {
  const clusterKey = buildClusterKey({
    signalType,
    tenantVolume,
  });

  const memory =
    federationMemory.get(clusterKey) ||
    (await cache.get(getFederationKey(clusterKey)));

  if (!memory) return 0;

  return Math.max(
    0,
    Math.round(memory.confidence * 8)
  );
}

module.exports = {
  publishTenantLearning,
  getFederatedBoost,
};