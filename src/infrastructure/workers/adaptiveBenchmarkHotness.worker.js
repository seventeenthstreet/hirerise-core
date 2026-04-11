const logger = require("../../shared/logger");
const {
  getTopHotBenchmarks,
} = require("../../modules/analytics/services/benchmarkHotness.service");

const {
  enqueueBenchmarkPrewarm,
} = require("./benchmarkMvPrewarm.worker");

const MAX_CONCURRENCY = 5;
let running = false;
let intervalRef = null;

async function processAdaptiveHotQueue() {
  if (running) return;
  running = true;

  try {
    const hotTargets = await getTopHotBenchmarks(50);

    const batch = hotTargets.slice(0, MAX_CONCURRENCY);

    await Promise.allSettled(
      batch.map((target) =>
        enqueueBenchmarkPrewarm({
          tenantId: target.tenantId,
          cohortKey: target.cohortKey,
          priority: Math.round(target.score),
          reason: "adaptive-hotness",
        })
      )
    );

    logger.info(
      `[AdaptiveHotnessWorker] queued ${batch.length} benchmark MV prewarm targets`
    );
  } catch (error) {
    logger.error(
      `[AdaptiveHotnessWorker] ${error.message}`
    );
  } finally {
    running = false;
  }
}

function startAdaptiveBenchmarkHotnessWorker({
  intervalMs = 30000,
} = {}) {
  if (intervalRef) return;

  intervalRef = setInterval(
    processAdaptiveHotQueue,
    intervalMs
  );

  logger.info(
    "[AdaptiveHotnessWorker] started"
  );
}

async function stopAdaptiveBenchmarkHotnessWorker() {
  if (intervalRef) {
    clearInterval(intervalRef);
    intervalRef = null;
  }

  while (running) {
    await new Promise((r) => setTimeout(r, 100));
  }

  logger.info(
    "[AdaptiveHotnessWorker] stopped gracefully"
  );
}

module.exports = {
  startAdaptiveBenchmarkHotnessWorker,
  stopAdaptiveBenchmarkHotnessWorker,
  processAdaptiveHotQueue,
};