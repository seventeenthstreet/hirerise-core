const logger = require("../../utils/logger");
const predictiveSplitBrain = require("./predictiveSplitBrain.service");
const consensusMemoryForecast = require("./consensusMemoryForecast.service");

const BASE_CONFIDENCE = 1;
const MIN_CONFIDENCE = 0.1;
const MAX_CONFIDENCE = 1;
const DECAY_RATE = 0.08;
const HEAL_RESTORE_RATE = 0.05;
const DEFAULT_LATENCY_MS = 120;

const peerConfidence = new Map();

function ensurePeer(region) {
  const key = region || "unknown";

  if (!peerConfidence.has(key)) {
    peerConfidence.set(key, {
      score: BASE_CONFIDENCE,
      updatedAt: Date.now(),
      failures: 0,
      heals: 0,
    });
  }

  return peerConfidence.get(key);
}

function clamp(score) {
  return Math.max(
    MIN_CONFIDENCE,
    Math.min(MAX_CONFIDENCE, Number(score.toFixed(4)))
  );
}

function decayConfidence(region, severity = 1) {
  const peer = ensurePeer(region);

  peer.failures += 1;
  peer.score = clamp(peer.score - DECAY_RATE * severity);
  peer.updatedAt = Date.now();

  return peer.score;
}

function restoreConfidence(region) {
  const peer = ensurePeer(region);

  peer.heals += 1;
  peer.score = clamp(peer.score + HEAL_RESTORE_RATE);
  peer.updatedAt = Date.now();

  return peer.score;
}

function getConfidence(region, tenantId) {
  const peer = ensurePeer(region);

  const risk = predictiveSplitBrain.getRiskScore(tenantId);
  const riskPenalty = risk * 0.35;

  return clamp(peer.score - riskPenalty);
}

function getWeightedVotes(votes = [], tenantId) {
  return votes.map((vote) => ({
    ...vote,
    confidence: getConfidence(vote.region, tenantId),
  }));
}

function recordConsensusForecast(weightedVotes = [], accepted, tenantId) {
  for (const vote of weightedVotes) {
    try {
      consensusMemoryForecast.recordConsensusEvent(
        vote.region || "unknown",
        {
          voteAligned: Boolean(vote.accepted) === Boolean(accepted),
          driftDetected: Boolean(vote.driftDetected),
          latency:
            Number(vote.latency) || DEFAULT_LATENCY_MS,
          region: vote.region || "unknown",
          tenantId,
        }
      );
    } catch (err) {
      logger.warn(
        "[Patch26] consensus forecast memory hook failed",
        {
          region: vote.region,
          error: err.message,
        }
      );
    }
  }
}

function majorityAccepted(votes = [], tenantId) {
  const weightedVotes = getWeightedVotes(votes, tenantId);

  const acceptedConfidence = weightedVotes
    .filter((v) => v.accepted)
    .reduce((sum, v) => sum + v.confidence, 0);

  const totalConfidence = weightedVotes.reduce(
    (sum, v) => sum + v.confidence,
    0
  );

  const accepted =
    totalConfidence > 0
      ? acceptedConfidence / totalConfidence >= 0.51
      : false;

  recordConsensusForecast(
    weightedVotes,
    accepted,
    tenantId
  );

  return accepted;
}

function shutdown() {
  const peers = peerConfidence.size;
  peerConfidence.clear();

  logger.info(
    `[Patch25+26] quorum confidence engine stopped peers=${peers}`
  );
}

module.exports = {
  decayConfidence,
  restoreConfidence,
  getConfidence,
  getWeightedVotes,
  majorityAccepted,
  shutdown,
};