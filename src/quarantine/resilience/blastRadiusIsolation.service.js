const logger = require("../../utils/logger");
const circuitMesh = require("./failureCircuitMesh.service");

const isolatedServices = new Set();

function isolateService(serviceName, reason = "unknown") {
  if (isolatedServices.has(serviceName)) {
    return;
  }

  isolatedServices.add(serviceName);

  logger.error(
    `[BlastRadiusIsolation] ISOLATED service=${serviceName} reason=${reason}`
  );
}

function releaseIsolation(serviceName) {
  if (!isolatedServices.has(serviceName)) {
    return;
  }

  isolatedServices.delete(serviceName);

  logger.info(
    `[BlastRadiusIsolation] RELEASED service=${serviceName}`
  );
}

function canRouteTraffic(serviceName) {
  if (isolatedServices.has(serviceName)) {
    return false;
  }

  return circuitMesh.canAcceptTraffic(serviceName);
}

function recordServiceFailure(serviceName, tenantId, reason) {
  circuitMesh.recordFailure(serviceName, tenantId, reason);

  const state = circuitMesh.getCircuitState(serviceName);

  if (state.state === circuitMesh.STATES.OPEN) {
    isolateService(serviceName, reason);
  }
}

function recordServiceSuccess(serviceName) {
  circuitMesh.recordSuccess(serviceName);

  const state = circuitMesh.getCircuitState(serviceName);

  if (state.state === circuitMesh.STATES.CLOSED) {
    releaseIsolation(serviceName);
  }
}

function getIsolationState() {
  return Array.from(isolatedServices.values());
}

module.exports = {
  isolateService,
  releaseIsolation,
  canRouteTraffic,
  recordServiceFailure,
  recordServiceSuccess,
  getIsolationState,
};