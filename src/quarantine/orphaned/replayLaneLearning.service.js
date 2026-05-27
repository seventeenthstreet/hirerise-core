const cache = require("./cacheProvider");
const logger = require("../../utils/logger");

const LEARNING_NS = "replay_lane_learning";
const DEFAULT_TTL = 60 * 60 * 6; // 6h adaptive memory

function key(tenantId, laneId) {
  return `${LEARNING_NS}:${tenantId}:${laneId}`;
}

async function getLaneProfile(tenantId, laneId) {
  try {
    return (
      (await cache.get(key(tenantId, laneId))) || {
        reward: 0,
        penalty: 0,
        confidence: 0.5,
        burstWins: 0,
        burstLosses: 0,
        samples: 0,
        lastUpdatedAt: Date.now(),
      }
    );
  } catch (error) {
    logger.warn("[ReplayLearning] getLaneProfile degraded fallback", {
      tenantId,
      laneId,
      error: error.message,
    });

    return {
      reward: 0,
      penalty: 0,
      confidence: 0.5,
      burstWins: 0,
      burstLosses: 0,
      samples: 0,
      degraded: true,
    };
  }
}

async function reinforceLane({
  tenantId,
  laneId,
  success,
  burstScore = 0,
  confidenceDelta = 0.05,
}) {
  const profile = await getLaneProfile(tenantId, laneId);

  profile.samples += 1;
  profile.lastUpdatedAt = Date.now();

  if (success) {
    profile.reward += 1 + burstScore;
    profile.burstWins += 1;
    profile.confidence = Math.min(
      0.99,
      profile.confidence + confidenceDelta
    );
  } else {
    profile.penalty += 1;
    profile.burstLosses += 1;
    profile.confidence = Math.max(
      0.05,
      profile.confidence - confidenceDelta * 1.5
    );
  }

  try {
    await cache.set(key(tenantId, laneId), profile, DEFAULT_TTL);
  } catch (error) {
    logger.warn("[ReplayLearning] reinforce degraded", {
      tenantId,
      laneId,
      error: error.message,
    });
  }

  return profile;
}

module.exports = {
  getLaneProfile,
  reinforceLane,
};