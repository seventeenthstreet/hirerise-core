const logger = require("../../utils/logger");
const blastIsolation = require("./blastRadiusIsolation.service");
const circuitMesh = require("./failureCircuitMesh.service");

let recoveryWorker = null;

const RECOVERY_INTERVAL_MS = Number(
  process.env.FAILURE_RECOVERY_INTERVAL_MS || 15000
);

function probeRecovery() {
  const states = circuitMesh.getAllCircuitStates();

  for (const state of states) {
    if (state.state !== circuitMesh.STATES.RECOVERING) {
      continue;
    }

    logger.info(
      `[RecoveryScheduler] probing service=${state.serviceName}`
    );

    blastIsolation.recordServiceSuccess(state.serviceName);
  }
}

function startRecoveryScheduler() {
  if (recoveryWorker) {
    return;
  }

  recoveryWorker = setInterval(probeRecovery, RECOVERY_INTERVAL_MS);

  logger.info("[RecoveryScheduler] started");
}

function stopRecoveryScheduler() {
  if (!recoveryWorker) {
    return;
  }

  clearInterval(recoveryWorker);
  recoveryWorker = null;

  logger.info("[RecoveryScheduler] stopped");
}

module.exports = {
  startRecoveryScheduler,
  stopRecoveryScheduler,
};