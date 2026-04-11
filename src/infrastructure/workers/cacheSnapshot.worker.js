const logger = require("../../utils/logger");
const lineageMesh = require("../cache/cacheLineageMesh.service");

async function preserveShutdownSnapshot() {
  const governance = lineageMesh.recoverGovernanceState();

  lineageMesh.snapshotGovernanceState({
    ...governance,
    shutdownSnapshot: true,
    snapshotTs: Date.now(),
  });

  logger.info("[Patch14] shutdown lineage snapshot preserved");
}

module.exports = {
  preserveShutdownSnapshot,
};