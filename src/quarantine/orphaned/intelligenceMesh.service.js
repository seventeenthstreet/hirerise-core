const cache = require("./cacheProvider");
const logger = require("../../utils/logger");

const MESH_NS = "predictive_intelligence_mesh";
const TTL = 60 * 10;

async function syncReplicaIntelligence(replicaId, payload) {
  try {
    const key = `${MESH_NS}:${replicaId}`;
    await cache.set(key, payload, TTL);
    return true;
  } catch (error) {
    logger.warn("[IntelligenceMesh] sync degraded", {
      replicaId,
      error: error.message,
    });
    return false;
  }
}

async function getReplicaIntelligence(replicaId) {
  try {
    return await cache.get(`${MESH_NS}:${replicaId}`);
  } catch (error) {
    logger.warn("[IntelligenceMesh] read degraded", {
      replicaId,
      error: error.message,
    });
    return null;
  }
}

module.exports = {
  syncReplicaIntelligence,
  getReplicaIntelligence,
};