const logger = require("../../utils/logger");
const lineageMesh = require("../cache/cacheLineageMesh.service");

let hydrationInterval = null;

function startCacheHydrationWorker() {
  if (hydrationInterval) return;

  hydrationInterval = setInterval(() => {
    const governance = lineageMesh.recoverGovernanceState();

    logger.info(
      `[Patch14] hydration heartbeat quorumEpoch=${governance.quorumEpoch}`
    );
  }, 60_000);

  logger.info("[Patch14] cache hydration worker started");
}

function stopCacheHydrationWorker() {
  if (hydrationInterval) {
    clearInterval(hydrationInterval);
    hydrationInterval = null;
  }

  logger.info("[Patch14] cache hydration worker stopped");
}

module.exports = {
  startCacheHydrationWorker,
  stopCacheHydrationWorker,
};