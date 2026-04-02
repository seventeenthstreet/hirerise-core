'use strict';

/**
 * modules/career-digital-twin/models/simulation.model.js
 *
 * SQL row builders and shared constants for the career_simulations table.
 *
 * Table:
 *   career_simulations
 *
 * Row shape:
 * ┌──────────────────────┬──────────────────────────────────────────────┐
 * │ Field                │ Type                                         │
 * ├──────────────────────┼──────────────────────────────────────────────┤
 * │ id                   │ uuid (db-generated)                          │
 * │ user_id              │ text / uuid                                 │
 * │ career_path          │ jsonb                                        │
 * │ salary_projection    │ text                                         │
 * │ risk_level           │ text                                         │
 * │ growth_score         │ integer                                      │
 * │ meta                 │ jsonb                                        │
 * │ created_at           │ timestamptz                                  │
 * └──────────────────────┴──────────────────────────────────────────────┘
 *
 * This module is intentionally Supabase-only.
 * No Firestore compatibility helpers remain.
 */

const TABLE = 'career_simulations';

// ───────────────────────────────────────────────────────────────────────────────
// Risk levels
// ───────────────────────────────────────────────────────────────────────────────

const RISK_LEVELS = Object.freeze({
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
});

const VALID_RISK_LEVELS = new Set(Object.values(RISK_LEVELS));

/**
 * Normalize risk level safely.
 *
 * @param {string|null|undefined} value
 * @returns {string}
 */
function normalizeRiskLevel(value) {
  return VALID_RISK_LEVELS.has(value)
    ? value
    : RISK_LEVELS.MEDIUM;
}

/**
 * Normalize growth score into integer 0–100.
 *
 * @param {unknown} value
 * @returns {number}
 */
function normalizeGrowthScore(value) {
  const score = Number(value);

  if (!Number.isFinite(score)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Build a production-safe SQL row payload for career_simulations.
 *
 * @param {string} userId
 * @param {Object} simulationResult
 * @returns {Object}
 */
function buildSimulationRow(userId, simulationResult = {}) {
  const paths = Array.isArray(simulationResult.career_paths)
    ? simulationResult.career_paths
    : [];

  const topPath =
    paths.length > 0 && paths[0] && typeof paths[0] === 'object'
      ? paths[0]
      : {};

  const meta =
    simulationResult.meta &&
    typeof simulationResult.meta === 'object' &&
    !Array.isArray(simulationResult.meta)
      ? simulationResult.meta
      : {};

  return {
    user_id: userId,
    career_path: paths,
    salary_projection: topPath.salary_projection ?? null,
    risk_level: normalizeRiskLevel(topPath.risk_level),
    growth_score: normalizeGrowthScore(topPath.growth_score),
    meta,
    created_at: new Date().toISOString(),
  };
}

module.exports = {
  TABLE,
  RISK_LEVELS,
  buildSimulationRow,
};