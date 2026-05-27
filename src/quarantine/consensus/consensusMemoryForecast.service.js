const logger = require("../../utils/logger");

const peerConsensusMemory = new Map();
const fragmentationForecast = new Map();

const MEMORY_WINDOW =
  Number(process.env.CONSENSUS_MEMORY_WINDOW_MS || 30 * 60 * 1000);
const FRAGMENT_RISK_THRESHOLD =
  Number(process.env.FRAGMENT_RISK_THRESHOLD || 3);
const MEMORY_MAX_EVENTS =
  Number(process.env.CONSENSUS_MEMORY_MAX_EVENTS || 120);

function now() {
  return Date.now();
}

function getPeerMemory(peerId) {
  if (!peerConsensusMemory.has(peerId)) {
    peerConsensusMemory.set(peerId, []);
  }

  return peerConsensusMemory.get(peerId);
}

function trimMemory(memory) {
  const cutoff = now() - MEMORY_WINDOW;

  while (memory.length && memory[0].timestamp < cutoff) {
    memory.shift();
  }

  while (memory.length > MEMORY_MAX_EVENTS) {
    memory.shift();
  }
}

function recordConsensusEvent(peerId, event = {}) {
  if (!peerId) return;

  const memory = getPeerMemory(peerId);

  memory.push({
    timestamp: now(),
    voteAligned: Boolean(event.voteAligned),
    driftDetected: Boolean(event.driftDetected),
    latency: Number(event.latency || 0),
    region: event.region || "global",
  });

  trimMemory(memory);
}

function calculateFragmentationRisk(memory = []) {
  if (!memory.length) return 0;

  let divergence = 0;
  let drift = 0;
  let latencyPressure = 0;

  for (const event of memory) {
    if (!event.voteAligned) divergence++;
    if (event.driftDetected) drift++;
    if (event.latency > 250) latencyPressure++;
  }

  return divergence + drift + latencyPressure;
}

function forecastPeerRisk(peerId) {
  const memory = getPeerMemory(peerId);
  trimMemory(memory);

  const risk = calculateFragmentationRisk(memory);

  fragmentationForecast.set(peerId, {
    peerId,
    risk,
    unstableSoon: risk >= FRAGMENT_RISK_THRESHOLD,
    lastUpdated: now(),
  });

  return fragmentationForecast.get(peerId);
}

function getHighRiskPeers() {
  const risky = [];

  for (const peerId of peerConsensusMemory.keys()) {
    const forecast = forecastPeerRisk(peerId);

    if (forecast.unstableSoon) {
      risky.push(forecast);
    }
  }

  return risky.sort((a, b) => b.risk - a.risk);
}

function startForecastLoop(intervalMs = 60000) {
  const timer = setInterval(() => {
    try {
      const riskyPeers = getHighRiskPeers();

      if (riskyPeers.length) {
        logger.warn(
          "[ConsensusMemoryForecast] High fragmentation risk peers detected",
          {
            peers: riskyPeers.slice(0, 10),
          }
        );
      }
    } catch (error) {
      logger.error(
        "[ConsensusMemoryForecast] Forecast loop failed",
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
    "[ConsensusMemoryForecast] Forecast engine started"
  );

  return {
    shutdown() {
      clearInterval(timer);
      logger.info(
        "[ConsensusMemoryForecast] Forecast engine stopped"
      );
    },
  };
}

module.exports = {
  recordConsensusEvent,
  forecastPeerRisk,
  getHighRiskPeers,
  startForecastLoop,
};