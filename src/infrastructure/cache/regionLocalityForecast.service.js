const logger = require("../../utils/logger");
const predictiveHeat = require("./predictiveHeat.service");

const localityHistory = new Map();

function recordRegionAccess(tenantId, region) {
  if (!tenantId || !region) return;

  const key = `${tenantId}:${region}`;
  const history = localityHistory.get(key) || [];

  history.push({
    ts: Date.now(),
    heat: predictiveHeat.getTenantHeat?.(tenantId) || 0,
  });

  while (history.length > 50) history.shift();

  localityHistory.set(key, history);
}

function forecastRegionDrift(tenantId, currentRegion) {
  const candidates = [];

  for (const [key, events] of localityHistory.entries()) {
    const [tenant, region] = key.split(":");
    if (tenant !== tenantId || region === currentRegion) continue;

    const weightedHeat = events.reduce((sum, e) => sum + e.heat, 0);
    const driftScore = weightedHeat / Math.max(events.length, 1);

    candidates.push({
      tenantId,
      targetRegion: region,
      driftScore,
    });
  }

  return candidates.sort((a, b) => b.driftScore - a.driftScore);
}

module.exports = {
  recordRegionAccess,
  forecastRegionDrift,
};