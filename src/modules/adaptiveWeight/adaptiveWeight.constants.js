'use strict';

/**
 * adaptiveWeight.constants.js
 *
 * Supabase-optimized constants for Adaptive Weight Engine
 * Fully decoupled from Firebase/Firestore patterns
 */

module.exports = Object.freeze({

  // ─────────────────────────────────────────────────────────────
  // 🗄️ TABLE CONFIG (Supabase / Postgres)
  // ─────────────────────────────────────────────────────────────
  TABLE: 'adaptive_weights',

  // Optional: schema if you use multiple schemas
  SCHEMA: 'public',

  // Primary key (for clarity in services)
  PRIMARY_KEY: 'id',

  // Composite uniqueness (recommended DB constraint)
  UNIQUE_KEYS: ['role_id', 'experience_bucket'],

  // ─────────────────────────────────────────────────────────────
  // ⚖️ DEFAULT WEIGHTS (must sum = 1.0)
  // ─────────────────────────────────────────────────────────────
  DEFAULT_WEIGHTS: Object.freeze({
    skills:     0.40,
    experience: 0.25,
    education:  0.15,
    projects:   0.20,
  }),

  // ─────────────────────────────────────────────────────────────
  // 🧱 WEIGHT BOUNDS (anti-dominance control)
  // ─────────────────────────────────────────────────────────────
  WEIGHT_BOUNDS: Object.freeze({
    min: 0.10,
    max: 0.60,
  }),

  // ─────────────────────────────────────────────────────────────
  // 📉 LEARNING RATE (stability-first tuning)
  // ─────────────────────────────────────────────────────────────
  DEFAULT_LEARNING_RATE: 0.02,

  // ─────────────────────────────────────────────────────────────
  // 🎯 CONFIDENCE MODEL
  // ─────────────────────────────────────────────────────────────
  CONFIDENCE: Object.freeze({
    initial:          0.50,
    minimumToUse:     0.60,
    incrementPerGood: 0.02,
    decayPerBad:      0.03,
    cap:              0.99,
  }),

  // ─────────────────────────────────────────────────────────────
  // 📊 PERFORMANCE TRACKING (EMA-based)
  // ─────────────────────────────────────────────────────────────
  PERFORMANCE: Object.freeze({
    initial:              0.50,
    degradationThreshold: 0.55,
    smoothingFactor:      0.10,
  }),

  // ─────────────────────────────────────────────────────────────
  // 🧾 OUTCOME VALUES (for training updates)
  // ─────────────────────────────────────────────────────────────
  OUTCOME: Object.freeze({
    HIRE:   1,
    REJECT: 0,
  }),

  // ─────────────────────────────────────────────────────────────
  // 🧑‍💼 EXPERIENCE BUCKETS (validation-safe)
  // ─────────────────────────────────────────────────────────────
  VALID_EXPERIENCE_BUCKETS: Object.freeze([
    '0-2',
    '3-5',
    '6-10',
    '10+',
  ]),

});
