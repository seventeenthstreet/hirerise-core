const logger = require("../../utils/logger");
const pressureIndex = require("./tenantPressureIndex.service");

function resolveExecutionLane(tenantId) {
  const isolated = pressureIndex.isTenantIsolated(tenantId);

  const lane = isolated ? "isolated-lane" : "shared-lane";

  logger.info(
    `[IsolationRouter] Tenant ${tenantId} routed to ${lane}`
  );

  return lane;
}

function routeCacheNamespace(tenantId, baseNamespace) {
  const lane = resolveExecutionLane(tenantId);
  return `${lane}:${baseNamespace}:${tenantId}`;
}

module.exports = {
  resolveExecutionLane,
  routeCacheNamespace,
};