const logger = require("../../utils/logger");

const regionalSnapshots = new Map();

function replicateLineageSnapshot(tenantId, region, snapshot) {
  if (!tenantId || !region) return;

  const key = `${tenantId}:${region}`;

  regionalSnapshots.set(key, {
    snapshot,
    replicatedAt: Date.now(),
  });

  logger.info(
    `[Patch16] Replicated lineage snapshot for ${tenantId} -> ${region}`
  );
}

function getRegionalSnapshot(tenantId, region) {
  return regionalSnapshots.get(`${tenantId}:${region}`) || null;
}

module.exports = {
  replicateLineageSnapshot,
  getRegionalSnapshot,
};