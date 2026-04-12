const logger = require("../../utils/logger");
const predictiveSplitBrain = require("./predictiveSplitBrain.service");

const BASE_CONFIDENCE = 1;
const MIN_CONFIDENCE = 0.1;
const MAX_CONFIDENCE = 1;
const DECAY_RATE = 0.08;
const HEAL_RESTORE_RATE = 0.05;

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

function majorityAccepted(votes = [], tenantId) {
  const weightedVotes = getWeightedVotes(votes, tenantId);

  const accepted = weightedVotes
    .filter((v) => v.accepted)
    .reduce((sum, v) => sum + v.confidence, 0);

  const total = weightedVotes.reduce(
    (sum, v) => sum + v.confidence,
    0
  );

  return total > 0 ? accepted / total >= 0.51 : false;
}

function shutdown() {
  const peers = peerConfidence.size;
  peerConfidence.clear();

  logger.info(
    `[Patch25] quorum confidence engine stopped peers=${peers}`
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