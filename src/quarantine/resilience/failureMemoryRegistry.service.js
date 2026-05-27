const logger = require("../../utils/logger");

const failureMemory = new Map();

function rememberFailure(serviceName, tenantId, reason) {
  const key = `${serviceName}:${tenantId || "global"}`;

  failureMemory.set(key, {
    serviceName,
    tenantId,
    reason,
    count: (failureMemory.get(key)?.count || 0) + 1,
    lastSeen: Date.now(),
  });

  logger.warn(
    `[FailureMemory] Remembered failure service=${serviceName} tenant=${tenantId} reason=${reason}`
  );
}

function getFailureMemory(serviceName, tenantId) {
  return failureMemory.get(`${serviceName}:${tenantId || "global"}`);
}

function getAllFailureMemory() {
  return Array.from(failureMemory.values());
}

module.exports = {
  rememberFailure,
  getFailureMemory,
  getAllFailureMemory,
};