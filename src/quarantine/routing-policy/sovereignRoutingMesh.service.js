const logger = require("../../utils/logger");

const routingState = {
  regionLatency: new Map(),
  regionHealth: new Map(),
};

function updateRegionLatency(region, latencyMs) {
  routingState.regionLatency.set(region, {
    latencyMs,
    updatedAt: Date.now(),
  });
}

function updateRegionHealth(region, isHealthy) {
  routingState.regionHealth.set(region, {
    isHealthy,
    updatedAt: Date.now(),
  });
}

function getLatency(region) {
  return routingState.regionLatency.get(region)?.latencyMs ?? 9999;
}

function isHealthy(region) {
  return routingState.regionHealth.get(region)?.isHealthy ?? true;
}

function routeRegion(allowedRegions = []) {
  const candidates = allowedRegions.filter(isHealthy);

  if (candidates.length === 0) {
    return allowedRegions[0] || "ap-south-1";
  }

  let bestRegion = candidates[0];
  let bestLatency = getLatency(bestRegion);

  for (const region of candidates) {
    const latency = getLatency(region);

    if (latency < bestLatency) {
      bestLatency = latency;
      bestRegion = region;
    }
  }

  logger.info(
    `[SovereignRouting] region=${bestRegion} latency=${bestLatency}`
  );

  return bestRegion;
}

module.exports = {
  updateRegionLatency,
  updateRegionHealth,
  routeRegion,
};