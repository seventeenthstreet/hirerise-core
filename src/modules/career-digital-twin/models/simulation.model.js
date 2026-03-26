'use strict';

/**
 * modules/career-digital-twin/models/simulation.model.js
 *
 * Defines the Firestore collection name, field contracts, and document
 * builders for career simulation records.
 *
 * Supabase SQL schema for career_simulations is in:
 *   src/migration/add-career-digital-twin.migration.js
 *
 * Firestore collection: career_simulations
 * Supabase table:       career_simulations
 *
 * Document / Row shape:
 * ┌──────────────────────┬───────────────────────────────────────────────────┐
 * │ Field                │ Type / Notes                                      │
 * ├──────────────────────┼───────────────────────────────────────────────────┤
 * │ id                   │ auto UUID (Supabase) / Firestore doc ID           │
 * │ user_id              │ string — user ID                             │
 * │ career_path          │ jsonb  — full CareerPath[]                        │
 * │ salary_projection    │ string — e.g. "₹18L"                             │
 * │ risk_level           │ 'Low' | 'Medium' | 'High'                        │
 * │ growth_score         │ integer 0–100                                     │
 * │ meta                 │ jsonb  — engine meta (role, industry, version)    │
 * │ created_at           │ timestamptz                                       │
 * └──────────────────────┴───────────────────────────────────────────────────┘
 */

const { FieldValue } = require('../../../config/supabase');

// ─── Collection / Table constants ────────────────────────────────────────────

const COLLECTION = 'career_simulations';   // Firestore collection
const TABLE      = 'career_simulations';   // Supabase table

// ─── Risk level enum ──────────────────────────────────────────────────────────

const RISK_LEVELS = Object.freeze({
  LOW:    'Low',
  MEDIUM: 'Medium',
  HIGH:   'High',
});

// ─── Document builder ─────────────────────────────────────────────────────────

/**
 * buildSimulationDoc(userId, simulationResult)
 *
 * Maps the raw engine output to a Firestore / Supabase-ready document.
 *
 * @param {string} userId
 * @param {Object} simulationResult  — output of CareerDigitalTwinEngine.simulateCareerPaths()
 * @returns {Object}  Document ready for Firestore .set() or Supabase .insert()
 */
function buildSimulationDoc(userId, simulationResult) {
  const paths      = simulationResult.career_paths || [];
  const topPath    = paths[0] || {};
  const meta       = simulationResult.meta || {};

  return {
    user_id:           userId,
    career_path:       paths,                          // full jsonb blob
    salary_projection: topPath.salary_projection || null,
    risk_level:        topPath.risk_level         || RISK_LEVELS.MEDIUM,
    growth_score:      topPath.growth_score       || 0,
    meta:              meta,
    created_at:        FieldValue.serverTimestamp(),   // swap for `new Date()` in Supabase
  };
}

/**
 * buildSupabaseDoc(userId, simulationResult)
 *
 * Same as buildSimulationDoc but uses a plain JS Date so it's compatible
 * with Supabase's JS client (which does not use Firebase FieldValue).
 *
 * @param {string} userId
 * @param {Object} simulationResult
 * @returns {Object}
 */
function buildSupabaseDoc(userId, simulationResult) {
  const doc = buildSimulationDoc(userId, simulationResult);
  doc.created_at = new Date().toISOString(); // override Firestore sentinel
  return doc;
}

module.exports = {
  COLLECTION,
  TABLE,
  RISK_LEVELS,
  buildSimulationDoc,
  buildSupabaseDoc,
};










