const logger = require("../../utils/logger");
const consensusMemoryForecast = require("./consensusMemoryForecast.service");

const WINDOW_LIMIT = Math.max(
  5,
  Number(process.env.SPLIT_BRAIN_PREDICTION_WINDOW) || 20
);

const RISK_THRESHOLD = Math.min(
  1,
  Math.max(
    0.1,
    Number(process.env.SPLIT_BRAIN_RISK_THRESHOLD) || 0.72
  )
);

const DAMPEN_TTL_MS = Math.max(
  10000,
  Number(process.env.SPLIT_BRAIN_DAMPEN_TTL_MS) || 30000
);

const DEFAULT_FORECAST_REGION = "split-brain-engine";

const tenantState = new Map();

function toSafeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function ensureTenantState(tenantId) {
  const safeTenantId = tenantId || "global";

  if (!tenantState.has(safeTenantId)) {
    tenantState.set(safeTenantId, {
      replaySpread: [],
      latencySpread: [],
      degradedPeers: [],
      dampenedUntil: 0,
      lastRiskScore: 0,
      lastUpdatedAt: Date.now(),
    });
  }

  return tenantState.get(safeTenantId);
}

function pushRollingPoint(buffer, value) {
  buffer.push({
    value: toSafeNumber(value),
    ts: Date.now(),
  });

  if (buffer.length > WINDOW_LIMIT) {
    buffer.shift();
  }
}

function calculateAcceleration(points) {
  if (!Array.isArray(points) || points.length < 3) {
    return 0;
  }

  const a = points[points.length - 3]?.value || 0;
  const b = points[points.length - 2]?.value || 0;
  const c = points[points.length - 1]?.value || 0;

  const velocity1 = b - a;
  const velocity2 = c - b;

  return Math.max(0, velocity2 - velocity1);
}

function normalize(value, divisor) {
  const safeDivisor = Math.max(1, toSafeNumber(divisor));
  const normalized = toSafeNumber(value) / safeDivisor;

  return Math.max(0, Math.min(1, normalized));
}

function computeRiskScore(state) {
  const replayVelocity = normalize(
    calculateAcceleration(state.replaySpread),
    8
  );

  const latencyAcceleration = normalize(
    calculateAcceleration(state.latencySpread),
    50
  );

  const degradedTrend = normalize(
    calculateAcceleration(state.degradedPeers),
    3
  );

  const weightedRisk =
    replayVelocity * 0.35 +
    latencyAcceleration * 0.35 +
    degradedTrend * 0.3;

  state.lastRiskScore = Number(
    Math.max(0, Math.min(1, weightedRisk)).toFixed(4)
  );

  return state.lastRiskScore;
}

function recordForecastMemory({
  tenantId,
  replaySpread,
  latencySpread,
  degradedPeers,
  risk,
}) {
  try {
    consensusMemoryForecast.recordConsensusEvent(
      DEFAULT_FORECAST_REGION,
      {
        voteAligned: risk < RISK_THRESHOLD,
        driftDetected:
          replaySpread > 0 ||
          degradedPeers > 0,
        latency: toSafeNumber(latencySpread),
        region: DEFAULT_FORECAST_REGION,
        tenantId,
      }
    );
  } catch (err) {
    logger.warn(
      "[Patch26] split-brain memory forecast hook failed",
      {
        tenantId,
        error: err.message,
      }
    );
  }
}

function armPromotionDampening(state, tenantId, risk) {
  const now = Date.now();
  const newExpiry = now + DAMPEN_TTL_MS;

  if (state.dampenedUntil < newExpiry) {
    state.dampenedUntil = newExpiry;
  }

  logger.warn(
    `[PredictiveSplitBrain] Dampening armed tenant=${tenantId} risk=${risk} ttlMs=${DAMPEN_TTL_MS}`
  );
}

function recordSignal({
  tenantId,
  replaySpread = 0,
  latencySpread = 0,
  degradedPeers = 0,
} = {}) {
  const safeTenantId = tenantId || "global";
  const state = ensureTenantState(safeTenantId);

  pushRollingPoint(state.replaySpread, replaySpread);
  pushRollingPoint(state.latencySpread, latencySpread);
  pushRollingPoint(state.degradedPeers, degradedPeers);

  state.lastUpdatedAt = Date.now();

  const risk = computeRiskScore(state);

  recordForecastMemory({
    tenantId: safeTenantId,
    replaySpread,
    latencySpread,
    degradedPeers,
    risk,
  });

  if (risk >= RISK_THRESHOLD) {
    armPromotionDampening(state, safeTenantId, risk);
  }

  return {
    tenantId: safeTenantId,
    risk,
    dampened: isPromotionDampened(safeTenantId),
    earlyHealingRecommended:
      shouldTriggerEarlyHealing(safeTenantId),
  };
}

function isPromotionDampened(tenantId) {
  const safeTenantId = tenantId || "global";
  const state = tenantState.get(safeTenantId);

  if (!state) {
    return false;
  }

  return Date.now() < state.dampenedUntil;
}

function shouldTriggerEarlyHealing(tenantId) {
  const safeTenantId = tenantId || "global";
  const state = tenantState.get(safeTenantId);

  if (!state) {
    return false;
  }

  return state.lastRiskScore >= RISK_THRESHOLD * 0.85;
}

function getRiskScore(tenantId) {
  const safeTenantId = tenantId || "global";
  return tenantState.get(safeTenantId)?.lastRiskScore || 0;
}

function getTenantState(tenantId) {
  const safeTenantId = tenantId || "global";
  const state = tenantState.get(safeTenantId);

  if (!state) {
    return null;
  }

  return {
    tenantId: safeTenantId,
    risk: state.lastRiskScore,
    dampened: isPromotionDampened(safeTenantId),
    dampenedUntil: state.dampenedUntil,
    lastUpdatedAt: state.lastUpdatedAt,
  };
}

function clearTenant(tenantId) {
  const safeTenantId = tenantId || "global";
  tenantState.delete(safeTenantId);
}

function shutdown() {
  const totalTenants = tenantState.size;
  tenantState.clear();

  logger.info(
    `[PredictiveSplitBrain+Patch26] Engine shutdown complete clearedTenants=${totalTenants}`
  );
}

module.exports = {
  recordSignal,
  isPromotionDampened,
  shouldTriggerEarlyHealing,
  getRiskScore,
  getTenantState,
  clearTenant,
  shutdown,
};