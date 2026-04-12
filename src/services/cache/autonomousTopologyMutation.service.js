const logger = require("../../utils/logger");
const consensusMemoryForecast = require("./consensusMemoryForecast.service");

const topologyState = new Map();
const DEFAULT_REGIONS = [
  "ap-south-1",
  "me-central-1",
  "eu-west-1",
];

const MUTATION_RISK_THRESHOLD = Number(
  process.env.TOPOLOGY_MUTATION_RISK_THRESHOLD || 5
);

const DEFAULT_TRUST_SCORE = 1;
const MIN_TRUST_SCORE = 0.35;

function ensureRegion(region) {
  const key = region || "unknown";

  if (!topologyState.has(key)) {
    topologyState.set(key, {
      region: key,
      trust: DEFAULT_TRUST_SCORE,
      reroutes: 0,
      mutatedAt: 0,
      unstable: false,
    });
  }

  return topologyState.get(key);
}

function clampTrust(value) {
  return Math.max(
    MIN_TRUST_SCORE,
    Math.min(DEFAULT_TRUST_SCORE, Number(value.toFixed(4)))
  );
}

function mutateRegion(region, risk) {
  const state = ensureRegion(region);

  state.trust = clampTrust(
    DEFAULT_TRUST_SCORE - risk * 0.08
  );
  state.reroutes += 1;
  state.unstable = true;
  state.mutatedAt = Date.now();

  logger.warn(
    `[Patch27] topology mutation applied region=${region} risk=${risk} trust=${state.trust}`
  );

  return state;
}

function stabilizeRegion(region) {
  const state = ensureRegion(region);

  state.trust = DEFAULT_TRUST_SCORE;
  state.unstable = false;

  return state;
}

function evaluateTopology() {
  const riskyPeers =
    consensusMemoryForecast.getHighRiskPeers();

  const mutated = [];

  for (const peer of riskyPeers) {
    if (peer.risk >= MUTATION_RISK_THRESHOLD) {
      mutated.push(
        mutateRegion(peer.peerId, peer.risk)
      );
    }
  }

  for (const region of DEFAULT_REGIONS) {
    if (!mutated.find((r) => r.region === region)) {
      stabilizeRegion(region);
    }
  }

  return mutated;
}

function getRegionTrust(region) {
  return ensureRegion(region).trust;
}

function getTopologyState() {
  return Array.from(topologyState.values()).sort(
    (a, b) => a.region.localeCompare(b.region)
  );
}

function startMutationWorker(intervalMs = 45000) {
  const timer = setInterval(() => {
    try {
      const mutations = evaluateTopology();

      if (mutations.length) {
        logger.warn(
          "[Patch27] autonomous topology mutations executed",
          {
            regions: mutations.map((m) => ({
              region: m.region,
              trust: m.trust,
              reroutes: m.reroutes,
            })),
          }
        );
      }
    } catch (error) {
      logger.error(
        "[Patch27] topology mutation worker failure",
        {
          error: error.message,
        }
      );
    }
  }, intervalMs);

  if (typeof timer.unref === "function") {
    timer.unref();
  }

  logger.info(
    "[Patch27] autonomous topology mutation worker started"
  );

  return {
    shutdown() {
      clearInterval(timer);
      logger.info(
        "[Patch27] autonomous topology mutation worker stopped"
      );
    },
  };
}

module.exports = {
  mutateRegion,
  stabilizeRegion,
  evaluateTopology,
  getRegionTrust,
  getTopologyState,
  startMutationWorker,
};