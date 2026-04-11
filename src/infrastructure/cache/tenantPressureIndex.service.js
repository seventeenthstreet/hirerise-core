const logger = require("../../utils/logger");

const pressureMap = new Map();

const DECAY_RATE = 0.92;
const ISOLATION_THRESHOLD = Number(
  process.env.TENANT_PRESSURE_ISOLATION_THRESHOLD || 0.75
);

function ensureTenant(tenantId) {
  if (!pressureMap.has(tenantId)) {
    pressureMap.set(tenantId, {
      score: 0,
      isolated: false,
      lastUpdated: Date.now(),
      spikes: 0,
    });
  }
  return pressureMap.get(tenantId);
}

function recordPressure(tenantId, delta = 0.1) {
  const tenant = ensureTenant(tenantId);

  tenant.score = Math.min(1, tenant.score + delta);
  tenant.lastUpdated = Date.now();

  if (delta >= 0.25) tenant.spikes += 1;

  if (!tenant.isolated && tenant.score >= ISOLATION_THRESHOLD) {
    tenant.isolated = true;
    logger.warn(
      `[TenantPressure] Tenant ${tenantId} moved to isolation lane`
    );
  }

  return tenant;
}

function decayAllPressure() {
  for (const [tenantId, tenant] of pressureMap.entries()) {
    tenant.score *= DECAY_RATE;

    if (tenant.isolated && tenant.score < ISOLATION_THRESHOLD * 0.6) {
      tenant.isolated = false;
      tenant.spikes = 0;
      logger.info(
        `[TenantPressure] Tenant ${tenantId} restored from isolation`
      );
    }
  }
}

function isTenantIsolated(tenantId) {
  return ensureTenant(tenantId).isolated;
}

function getTenantPressureSnapshot() {
  return Array.from(pressureMap.entries()).map(([tenantId, state]) => ({
    tenantId,
    ...state,
  }));
}

module.exports = {
  recordPressure,
  decayAllPressure,
  isTenantIsolated,
  getTenantPressureSnapshot,
};