const logger = require("../../utils/logger");
const failureMemory = require("./failureMemoryRegistry.service");

const circuits = new Map();

const STATES = {
  CLOSED: "CLOSED",
  DEGRADED: "DEGRADED",
  OPEN: "OPEN",
  RECOVERING: "RECOVERING",
};

const DEFAULTS = {
  degradeThreshold: Number(process.env.FAILURE_DEGRADE_THRESHOLD || 3),
  openThreshold: Number(process.env.FAILURE_OPEN_THRESHOLD || 5),
  recoveryThreshold: Number(process.env.FAILURE_RECOVERY_THRESHOLD || 2),
  coolDownMs: Number(process.env.FAILURE_COOLDOWN_MS || 30000),
};

function ensureCircuit(serviceName) {
  if (!circuits.has(serviceName)) {
    circuits.set(serviceName, {
      state: STATES.CLOSED,
      faults: 0,
      recoveries: 0,
      lastFailureAt: 0,
      openedAt: 0,
    });
  }

  return circuits.get(serviceName);
}

function recordSuccess(serviceName) {
  const circuit = ensureCircuit(serviceName);

  if (
    circuit.state === STATES.RECOVERING ||
    circuit.state === STATES.DEGRADED
  ) {
    circuit.recoveries += 1;

    if (circuit.recoveries >= DEFAULTS.recoveryThreshold) {
      circuit.state = STATES.CLOSED;
      circuit.faults = 0;
      circuit.recoveries = 0;

      logger.info(`[FailureCircuit] CLOSED service=${serviceName}`);
    }
  }
}

function recordFailure(serviceName, tenantId, reason) {
  const circuit = ensureCircuit(serviceName);

  circuit.faults += 1;
  circuit.lastFailureAt = Date.now();

  failureMemory.rememberFailure(serviceName, tenantId, reason);

  if (circuit.faults >= DEFAULTS.openThreshold) {
    circuit.state = STATES.OPEN;
    circuit.openedAt = Date.now();

    logger.error(`[FailureCircuit] OPEN service=${serviceName}`);
    return;
  }

  if (circuit.faults >= DEFAULTS.degradeThreshold) {
    circuit.state = STATES.DEGRADED;
    logger.warn(`[FailureCircuit] DEGRADED service=${serviceName}`);
  }
}

function canAcceptTraffic(serviceName) {
  const circuit = ensureCircuit(serviceName);

  if (circuit.state === STATES.OPEN) {
    const elapsed = Date.now() - circuit.openedAt;

    if (elapsed >= DEFAULTS.coolDownMs) {
      circuit.state = STATES.RECOVERING;
      circuit.recoveries = 0;

      logger.info(`[FailureCircuit] RECOVERING service=${serviceName}`);
      return true;
    }

    return false;
  }

  return true;
}

function getCircuitState(serviceName) {
  return ensureCircuit(serviceName);
}

function getAllCircuitStates() {
  return Array.from(circuits.entries()).map(([serviceName, state]) => ({
    serviceName,
    ...state,
  }));
}

module.exports = {
  STATES,
  recordSuccess,
  recordFailure,
  canAcceptTraffic,
  getCircuitState,
  getAllCircuitStates,
};