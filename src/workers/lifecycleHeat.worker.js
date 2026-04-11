const logger = require("../utils/logger");
const predictiveConsensus = require(
  "../infrastructure/cache/predictiveConsensus.service"
);

const DEFAULT_MIN_CONFIDENCE = 0.25;
const MAX_REPLAY_TENANTS_PER_WAVE = 100;

async function replayDeployConsensus({
  activeTenants = [],
  warmFn,
  minConfidence = DEFAULT_MIN_CONFIDENCE,
  replaySource = "deploy-replay",
}) {
  if (!Array.isArray(activeTenants) || activeTenants.length === 0) {
    logger.info("[LifecycleHeat] no active tenants available for replay");
    return {
      success: true,
      replayed: 0,
      skipped: 0,
      total: 0,
    };
  }

  if (typeof warmFn !== "function") {
    throw new Error("replayDeployConsensus requires a valid warmFn");
  }

  let replayed = 0;
  let skipped = 0;
  let failed = 0;

  const limitedTenants = activeTenants.slice(0, MAX_REPLAY_TENANTS_PER_WAVE);

  for (const tenantId of limitedTenants) {
    try {
      const snapshot = await predictiveConsensus.getConsensusSnapshot({
        tenantId,
        signal: replaySource,
      });

      // degraded fallback fairness
      if (snapshot.degraded) {
        await warmFn(tenantId, {
          source: `${replaySource}-degraded`,
          confidence: 0.1,
          degraded: true,
        });

        replayed += 1;
        continue;
      }

      // quorum-backed replay threshold
      if (snapshot.confidence >= minConfidence) {
        await warmFn(tenantId, {
          source: replaySource,
          confidence: snapshot.confidence,
          quorum: snapshot.quorum,
        });

        replayed += 1;
      } else {
        skipped += 1;
      }
    } catch (error) {
      failed += 1;

      logger.warn(
        `[LifecycleHeat] replay failed tenant=${tenantId} error=${error.message}`
      );
    }
  }

  logger.info(
    `[LifecycleHeat] replay complete replayed=${replayed} skipped=${skipped} failed=${failed} total=${limitedTenants.length}`
  );

  return {
    success: failed === 0,
    replayed,
    skipped,
    failed,
    total: limitedTenants.length,
  };
}

module.exports = {
  replayDeployConsensus,
};
