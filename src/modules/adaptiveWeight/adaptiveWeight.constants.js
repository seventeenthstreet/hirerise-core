// adaptiveWeight.constants.js

module.exports = {

  COLLECTION: "adaptive_weights",

  // ─── Default Weight Template ─────────────────────────────────────────────────
  // Returned when no adaptive record exists or confidence is too low.
  // Must sum to exactly 1.0.
  DEFAULT_WEIGHTS: {
    skills:     0.40,
    experience: 0.25,
    education:  0.15,
    projects:   0.20,
  },

  // ─── Weight Boundary Enforcement ─────────────────────────────────────────────
  // Prevents any single dimension from dominating or becoming irrelevant.
  WEIGHT_BOUNDS: {
    min: 0.10,
    max: 0.60,
  },

  // ─── Learning Rate ────────────────────────────────────────────────────────────
  // Controls how aggressively weights shift per outcome.
  // Low by design — stability over speed.
  DEFAULT_LEARNING_RATE: 0.02,

  // ─── Confidence Thresholds ────────────────────────────────────────────────────
  // Below minimumConfidence → fall back to default weights regardless of record.
  // confidenceIncrement: how much confidence grows per successful recorded outcome.
  // decayIncrement: how much confidence shrinks when performance drops.
  CONFIDENCE: {
    initial:          0.50,
    minimumToUse:     0.60,   // below this → use defaults
    incrementPerGood: 0.02,
    decayPerBad:      0.03,
    cap:              0.99,
  },

  // ─── Performance Score ────────────────────────────────────────────────────────
  // performanceScore tracks rolling prediction accuracy (0–1).
  // Below degradationThreshold → decay confidence.
  PERFORMANCE: {
    initial:              0.50,
    degradationThreshold: 0.55,
    smoothingFactor:      0.10,  // EMA factor for rolling update
  },

  // ─── Outcome Values ───────────────────────────────────────────────────────────
  OUTCOME: {
    HIRE:   1,
    REJECT: 0,
  },

  // ─── Experience Buckets (for validation) ─────────────────────────────────────
  VALID_EXPERIENCE_BUCKETS: ["0-2", "3-5", "6-10", "10+"],
};