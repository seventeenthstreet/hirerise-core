'use strict';

/**
 * sovereignRoutingMesh.service.js — STUB
 *
 * Missing file — caused server crash at startup (line 5126).
 *
 * API surface used by server.js:
 *   - updateRegionLatency(regionId, latencyMs)
 *   - updateRegionHealth(regionId, isHealthy)
 */

const _regions = new Map();

function updateRegionLatency(regionId, latencyMs) {
  const entry = _regions.get(regionId) ?? {};
  _regions.set(regionId, { ...entry, latency: latencyMs });
}

function updateRegionHealth(regionId, isHealthy) {
  const entry = _regions.get(regionId) ?? {};
  _regions.set(regionId, { ...entry, healthy: isHealthy });
}

module.exports = {
  updateRegionLatency,
  updateRegionHealth,
};
