'use strict';

/**
 * career-path.engine.js — Standalone Career Path Prediction Engine
 *
 * Loads career progression chains from /data/career-paths.csv and
 * provides two public functions:
 *
 *   predictCareerPath({ role, experience_years, skills, industry })
 *     → Full prediction with experience-adjusted timeline
 *
 *   getProgressionChain(role, industry)
 *     → Raw CSV chain for a role (used by GET /chain/:role)
 *
 * CSV format: role, next_role, years_to_next, industry
 *
 * Design decisions:
 *   - In-memory cache with TTL (1 hour) to avoid repeated disk I/O
 *   - Case-insensitive + trimmed role matching
 *   - Industry filter prefers matching rows, falls back to any match
 *   - Experience-aware: skips steps already completed by experience_years
 *   - Pure Node.js fs/readline — no external CSV dependency
 *
 * @module engines/career-path.engine
 */

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');
const logger   = require('../utils/logger');

// ─── Config ───────────────────────────────────────────────────────────────────

const CSV_PATH     = path.resolve(__dirname, '../data/career-paths.csv');
const CACHE_TTL_MS = parseInt(process.env.CAREER_PATH_CACHE_TTL_MS || '3600000', 10);

// ─── In-memory cache ──────────────────────────────────────────────────────────

const _cache = {
  rows:     null,   // Array<{ role, next_role, years_to_next, industry }>
  loadedAt: null,
};

// ─── CSV loader ───────────────────────────────────────────────────────────────

/**
 * Load and cache career-paths.csv rows.
 * @returns {Promise<Array>}
 */
async function _loadCSV() {
  const now = Date.now();
  if (_cache.rows && _cache.loadedAt && (now - _cache.loadedAt < CACHE_TTL_MS)) {
    return _cache.rows;
  }

  if (!fs.existsSync(CSV_PATH)) {
    logger.warn('[CareerPathEngine] career-paths.csv not found at', CSV_PATH);
    _cache.rows     = [];
    _cache.loadedAt = now;
    return _cache.rows;
  }

  const rows = await new Promise((resolve, reject) => {
    const results  = [];
    let   headers  = null;

    const rl = readline.createInterface({
      input:     fs.createReadStream(CSV_PATH, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    rl.on('line', (raw) => {
      const line = raw.trim();
      if (!line) return;

      const fields = line.split(',').map(f => f.trim().replace(/^"|"$/g, ''));

      if (!headers) {
        headers = fields.map(h => h.toLowerCase().replace(/\s+/g, '_'));
        return;
      }

      const row = {};
      headers.forEach((key, i) => { row[key] = fields[i] ?? ''; });
      if (row.role && row.next_role) results.push(row);
    });

    rl.on('close',  () => resolve(results));
    rl.on('error', (err) => {
      logger.error('[CareerPathEngine] CSV read error:', err.message);
      resolve([]);
    });
  });

  _cache.rows     = rows;
  _cache.loadedAt = now;

  logger.info('[CareerPathEngine] CSV loaded', { rows: rows.length });
  return rows;
}

// ─── Normalisation ────────────────────────────────────────────────────────────

function _norm(str) {
  return (str || '').toLowerCase().trim();
}

// ─── Chain builder ────────────────────────────────────────────────────────────

/**
 * Build a linear progression chain starting from `startRole`.
 * Prefers rows whose industry matches `industryFilter` (case-insensitive).
 * Falls back to any row matching the role if no industry match exists.
 * Stops after 20 steps to prevent infinite loops in circular data.
 *
 * @param {Array}  rows
 * @param {string} startRole
 * @param {string|null} industryFilter
 * @returns {Array<{ role, next_role, years_to_next, industry }>}
 */
function _buildChain(rows, startRole, industryFilter) {
  const chain   = [];
  const visited = new Set();
  let   current = _norm(startRole);

  for (let i = 0; i < 20; i++) {
    if (visited.has(current)) break;
    visited.add(current);

    // Prefer industry-matching row, fall back to any match
    let row = null;
    if (industryFilter) {
      row = rows.find(
        r => _norm(r.role) === current && _norm(r.industry) === _norm(industryFilter)
      );
    }
    if (!row) {
      row = rows.find(r => _norm(r.role) === current);
    }

    if (!row) break;

    chain.push({
      role:          row.role,
      next_role:     row.next_role,
      years_to_next: parseFloat(row.years_to_next) || 2,
      industry:      row.industry || null,
    });

    current = _norm(row.next_role);
  }

  return chain;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * getProgressionChain(role, industry?)
 *
 * Returns the raw CSV chain for a role — no experience adjustment.
 * Used by GET /api/v1/career-path/chain/:role
 *
 * @param {string}      role
 * @param {string|null} [industry]
 * @returns {Promise<Array>}
 */
async function getProgressionChain(role, industry = null) {
  const rows  = await _loadCSV();
  const chain = _buildChain(rows, role, industry);
  return chain;
}

/**
 * predictCareerPath({ role, experience_years, skills, industry })
 *
 * Full prediction with experience-adjusted timeline.
 * Skips steps the user has already passed based on experience_years.
 * Returns the structured response expected by career-path.routes.js.
 *
 * @param {Object} params
 * @param {string}   params.role
 * @param {number}   [params.experience_years=0]
 * @param {string[]} [params.skills=[]]
 * @param {string}   [params.industry=null]
 * @returns {Promise<Object>}
 */
async function predictCareerPath({ role, experience_years = 0, skills = [], industry = null }) {
  const rows  = await _loadCSV();
  const chain = _buildChain(rows, role, industry);

  if (chain.length === 0) {
    logger.info('[CareerPathEngine] No chain found', { role, industry });
    return {
      current_role:           role,
      experience_years,
      career_path:            [],
      total_estimated_years:  0,
      next_role:              null,
      steps:                  0,
      source:                 'csv',
    };
  }

  // Adjust timeline: subtract experience already accumulated
  let remainingExperience = experience_years;
  let cumulativeYears     = 0;
  const careerPath        = [];

  for (const step of chain) {
    const yearsForStep = step.years_to_next;

    if (remainingExperience >= yearsForStep) {
      // User has already passed this transition — skip it
      remainingExperience -= yearsForStep;
      continue;
    }

    // Partial credit: reduce time for experience already in this band
    const adjustedYears = parseFloat((yearsForStep - remainingExperience).toFixed(1));
    remainingExperience = 0;
    cumulativeYears    += adjustedYears;

    careerPath.push({
      role:             step.next_role,
      estimated_years:  parseFloat(cumulativeYears.toFixed(1)),
      years_to_reach:   adjustedYears,
      industry:         step.industry || null,
    });
  }

  const totalEstimatedYears = careerPath.length > 0
    ? careerPath[careerPath.length - 1].estimated_years
    : 0;

  return {
    current_role:          role,
    experience_years,
    career_path:           careerPath,
    total_estimated_years: totalEstimatedYears,
    next_role:             careerPath[0]?.role ?? null,
    steps:                 careerPath.length,
    source:                'csv',
  };
}

/**
 * Invalidate the CSV cache (e.g. after a hot-reload of the data file).
 */
function invalidateCache() {
  _cache.rows     = null;
  _cache.loadedAt = null;
  logger.info('[CareerPathEngine] Cache invalidated');
}

module.exports = { predictCareerPath, getProgressionChain, invalidateCache };








