const logger = require("../../utils/logger");

const tenantPolicyState = new Map();
let policyWorker = null;

const DEFAULT_POLICY = {
  replayWeight: 1,
  anomalyWeight: 1,
  confidence: 1,
  inheritedFromSwarm: true,
  quarantine: false,
  driftScore: 0,
  lastUpdatedAt: Date.now(),
};

function getTenantPolicy(tenantId) {
  return tenantPolicyState.get(tenantId) || {
    ...DEFAULT_POLICY,
  };
}

function setTenantPolicy(tenantId, patch = {}) {
  const current = getTenantPolicy(tenantId);

  const next = {
    ...current,
    ...patch,
    lastUpdatedAt: Date.now(),
  };

  tenantPolicyState.set(tenantId, next);
  return next;
}

function deriveInheritedSwarmPolicy(globalReplayWeight = 1) {
  return {
    replayWeight: Math.max(0.5, globalReplayWeight),
    anomalyWeight: 1,
    confidence: 0.95,
    inheritedFromSwarm: true,
  };
}

function computeConfidenceDecay(policy) {
  const ageMinutes =
    (Date.now() - policy.lastUpdatedAt) / 60000;

  return Math.max(0.4, policy.confidence - ageMinutes * 0.002);
}

function selfHealReplayDrift(tenantId, replayDrift = 0) {
  const policy = getTenantPolicy(tenantId);

  const nextDrift =
    policy.driftScore * 0.7 + replayDrift * 0.3;

  const quarantine = nextDrift > 0.8;

  return setTenantPolicy(tenantId, {
    driftScore: nextDrift,
    quarantine,
    replayWeight: quarantine
      ? Math.max(0.25, policy.replayWeight * 0.7)
      : Math.min(2, policy.replayWeight * 1.02),
    confidence: Math.max(
      0.35,
      policy.confidence - Math.min(0.15, nextDrift * 0.05)
    ),
  });
}

function autonomousReplayDecision({
  tenantId,
  replayPressure = 0,
  anomalyScore = 0,
  globalReplayWeight = 1,
}) {
  let policy = getTenantPolicy(tenantId);

  if (policy.inheritedFromSwarm) {
    policy = setTenantPolicy(
      tenantId,
      deriveInheritedSwarmPolicy(globalReplayWeight)
    );
  }

  const confidence = computeConfidenceDecay(policy);

  const score =
    replayPressure * policy.replayWeight -
    anomalyScore * policy.anomalyWeight;

  return {
    shouldReplay:
      !policy.quarantine &&
      confidence > 0.45 &&
      score > 0.35,
    confidence,
    quarantine: policy.quarantine,
    policy,
  };
}

function stopReplayPolicyWorker() {
  if (policyWorker) {
    clearInterval(policyWorker);
    policyWorker = null;
  }
}

function startReplayPolicyWorker({
  getTenantReplayMetrics,
  getGlobalSwarmWeight,
  intervalMs = 45000,
}) {
  stopReplayPolicyWorker();

  policyWorker = setInterval(async () => {
    try {
      const tenants =
        (await getTenantReplayMetrics?.()) || [];

      for (const metric of tenants) {
        const swarmWeight =
          (await getGlobalSwarmWeight?.()) || 1;

        selfHealReplayDrift(
          metric.tenantId,
          metric.replayDrift || 0
        );

        autonomousReplayDecision({
          tenantId: metric.tenantId,
          replayPressure: metric.replayPressure || 0,
          anomalyScore: metric.anomalyScore || 0,
          globalReplayWeight: swarmWeight,
        });
      }

      logger.info(
        `[ReplayPolicy] governance cycle complete (${tenants.length} tenants)`
      );
    } catch (error) {
      logger.warn(
        `[ReplayPolicy] governance cycle failed: ${error.message}`
      );
    }
  }, intervalMs);

  logger.info("[ReplayPolicy] worker started");
}

module.exports = {
  getTenantPolicy,
  setTenantPolicy,
  autonomousReplayDecision,
  selfHealReplayDrift,
  startReplayPolicyWorker,
  stopReplayPolicyWorker,
};