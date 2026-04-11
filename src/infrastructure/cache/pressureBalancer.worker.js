const logger = require("../../utils/logger");
const pressureIndex = require("./tenantPressureIndex.service");

let balancerInterval = null;

function startPressureBalancerWorker() {
  if (balancerInterval) return;

  logger.info("[PressureBalancer] Starting worker");

  balancerInterval = setInterval(() => {
    try {
      pressureIndex.decayAllPressure();
    } catch (error) {
      logger.error(
        `[PressureBalancer] Worker failure: ${error.message}`
      );
    }
  }, 15000);
}

function stopPressureBalancerWorker() {
  if (balancerInterval) {
    clearInterval(balancerInterval);
    balancerInterval = null;
    logger.info("[PressureBalancer] Worker stopped");
  }
}

module.exports = {
  startPressureBalancerWorker,
  stopPressureBalancerWorker,
};