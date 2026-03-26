'use strict';

/**
 * career-opportunity.engine.js — Standalone Career Opportunity Engine
 *
 * Analyses a user profile and returns ranked career opportunities using
 * two complementary data sources:
 *
 *   1. CSV-based skill overlap scoring  (/data/role-transition.csv)
 *      Fast, deterministic, works without Firestore connectivity.
 *      match_score = (skill_overlap_weight × 70) + (experience_factor × 30)
 *
 *   2. Firestore market demand enrichment (via chiV2/careerOpportunityEngine)
 *      When available, enriches CSV results with live market signals:
 *      job_postings, growth_rate, remote_ratio, competition_score.
 *      Falls back gracefully if Firestore is unavailable.
 *
 * Public API:
 *   analyzeCareerOpportunities(userProfile)   → CareerOpportunityResult
 *
 * CHI Integration:
 *   The CHI engine (intelligenceOrchestrator) calls the chiV2 module directly.
 *   This standalone engine is also re-exported for CHI to optionally use
 *   when operating in CSV-only mode (e.g. before Firestore data is seeded).
 *
 * SECURITY: Read-only. No writes. No auth mutations.
 *
 * @module engines/career-opportunity.engine
 */

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');
const logger   = require('../utils/logger');

// ─── Config ───────────────────────────────────────────────────────────────────

const CSV_PATH     = path.resolve(__dirname, '../data/role-transition.csv');
const CACHE_TTL_MS = parseInt(process.env.CAREER_OPP_CACHE_TTL_MS || '3600000', 10);

// Scoring formula weights
const SKILL_OVERLAP_WEIGHT  = 0.70;
const EXPERIENCE_WEIGHT     = 0.30;

// Experience factor thresholds (years → bonus multiplier 0–1)
const EXPERIENCE_TIERS = [
  { min: 10, factor: 1.00 },
  { min: 7,  factor: 0.90 },
  { min: 5,  factor: 0.80 },
  { min: 3,  factor: 0.65 },
  { min: 1,  factor: 0.50 },
  { min: 0,  factor: 0.35 },
];

const DEFAULT_TOP_N = 5;
const MAX_TOP_N     = 20;

// ─── In-memory cache ──────────────────────────────────────────────────────────

const _cache = {
  rows:     null,   // Array<{ current_role, next_role, skill_overlap_weight }>
  loadedAt: null,
};

// ─── CSV Loader ───────────────────────────────────────────────────────────────

/**
 * Load and cache role-transition.csv rows.
 * Returns empty array gracefully if file is missing.
 *
 * @returns {Promise<Array<{current_role: string, next_role: string, skill_overlap_weight: number}>>}
 */
async function _loadCSV() {
  const now = Date.now();
  if (_cache.rows && _cache.loadedAt && (now - _cache.loadedAt < CACHE_TTL_MS)) {
    return _cache.rows;
  }

  if (!fs.existsSync(CSV_PATH)) {
    logger.warn('[CareerOpportunityEngine] role-transition.csv not found at', CSV_PATH);
    _cache.rows     = [];
    _cache.loadedAt = now;
    return _cache.rows;
  }

  const rows = await new Promise((resolve) => {
    const results = [];
    let   headers = null;

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

      if (row.current_role && row.next_role) {
        results.push({
          current_role:         row.current_role,
          next_role:            row.next_role,
          skill_overlap_weight: parseFloat(row.skill_overlap_weight) || 0.5,
        });
      }
    });

    rl.on('close', () => resolve(results));
    rl.on('error', (err) => {
      logger.error('[CareerOpportunityEngine] CSV read error:', err.message);
      resolve([]);
    });
  });

  _cache.rows     = rows;
  _cache.loadedAt = now;

  logger.info('[CareerOpportunityEngine] CSV loaded', { rows: rows.length });
  return rows;
}

// ─── Normalisation ────────────────────────────────────────────────────────────

function _norm(str) {
  return (str || '').toLowerCase().trim();
}

// ─── Scoring Helpers ──────────────────────────────────────────────────────────

/**
 * Calculate experience factor (0–1) from years of experience.
 */
function _experienceFactor(years) {
  const y = Math.max(0, Number(years) || 0);
  for (const tier of EXPERIENCE_TIERS) {
    if (y >= tier.min) return tier.factor;
  }
  return 0.35;
}

/**
 * Calculate skill overlap ratio between user skills and a role name.
 * Uses the CSV skill_overlap_weight as the base signal.
 * When user skills are provided, adjusts weight by actual keyword overlap.
 *
 * @param {number}   csvWeight   - skill_overlap_weight from CSV (0–1)
 * @param {string[]} userSkills  - normalised user skill names
 * @param {string}   nextRole    - target role name
 * @returns {number} 0–1
 */
function _computeSkillOverlap(csvWeight, userSkills, nextRole) {
  if (!userSkills || userSkills.length === 0) {
    // No user skills provided — use CSV weight as-is
    return csvWeight;
  }

  // Extract keywords from the role name to approximate required skills
  const roleKeywords = _norm(nextRole)
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2);

  if (roleKeywords.length === 0) return csvWeight;

  // Count how many role keywords appear in user's skill list
  const normUserSkills = userSkills.map(_norm);
  const matchCount = roleKeywords.filter(kw =>
    normUserSkills.some(s => s.includes(kw) || kw.includes(s))
  ).length;

  const keywordBonus = matchCount / roleKeywords.length; // 0–1

  // Blend CSV weight with keyword-based overlap (60% CSV, 40% keyword match)
  return Math.min(csvWeight * 0.60 + keywordBonus * 0.40, 1.0);
}

/**
 * Core match score formula:
 *   match_score = (skill_overlap × 70) + (experience_factor × 30)
 *
 * @param {number} skillOverlap     - 0–1
 * @param {number} experienceFactor - 0–1
 * @returns {number} 0–100 integer
 */
function _computeMatchScore(skillOverlap, experienceFactor) {
  const raw =
    (skillOverlap    * 100 * SKILL_OVERLAP_WEIGHT) +
    (experienceFactor * 100 * EXPERIENCE_WEIGHT);

  return Math.round(Math.min(raw, 100));
}

// ─── Firestore Enrichment (optional) ─────────────────────────────────────────

/**
 * Attempt to enrich opportunities with Firestore market demand data.
 * Uses the existing chiV2/careerOpportunityEngine for the heavy lifting.
 * Returns null silently if Firestore is unavailable or role not resolved.
 *
 * @param {string}   currentRole
 * @param {number|null} chiScore
 * @param {string|null} country
 * @param {number}   topN
 * @returns {Promise<Object|null>}
 */
async function _tryFirestoreEnrichment(currentRole, chiScore, country, topN) {
  try {
    const { analyseCareerOpportunities } = require('../modules/chiV2/careerOpportunityEngine');
    const { resolveRoleId }              = require('../modules/chiV2/chiV2.engine');

    const currentRoleId = await resolveRoleId(currentRole);
    if (!currentRoleId) return null;

    const result = await analyseCareerOpportunities(
      { current_role_id: currentRoleId, chi_score: chiScore },
      { country, top_n: topN }
    );

    return result;
  } catch (err) {
    // Firestore may not be seeded yet — degrade gracefully
    logger.debug('[CareerOpportunityEngine] Firestore enrichment skipped:', err.message);
    return null;
  }
}

// ─── Insights Generator ───────────────────────────────────────────────────────

/**
 * Generate human-readable insights from the ranked opportunities.
 *
 * @param {Object[]} opportunities
 * @param {string}   role
 * @returns {string[]}
 */
function _generateInsights(opportunities, role) {
  if (opportunities.length === 0) {
    return [`No career transition data found for "${role}" — ensure role-transition.csv is populated`];
  }

  const insights = [];
  const top      = opportunities[0];

  insights.push(`Your strongest opportunity from "${role}" is "${top.role}" with a match score of ${top.match_score}`);

  const highMatches = opportunities.filter(o => o.match_score >= 80);
  if (highMatches.length > 1) {
    insights.push(`${highMatches.length} roles show strong alignment (score ≥ 80) with your profile`);
  }

  const medMatches = opportunities.filter(o => o.match_score >= 60 && o.match_score < 80);
  if (medMatches.length > 0) {
    insights.push(`${medMatches.length} additional role${medMatches.length > 1 ? 's' : ''} show moderate alignment — worth exploring with targeted upskilling`);
  }

  return insights;
}

// ─── Main Public API ──────────────────────────────────────────────────────────

/**
 * analyzeCareerOpportunities(userProfile) → CareerOpportunityResult
 *
 * Accepts a user profile, finds all matching next roles from the
 * role-transition CSV, scores them, and returns ranked opportunities.
 *
 * When Firestore market data is available, each opportunity is also enriched
 * with live signals (job_postings, growth_rate, remote_ratio, etc.).
 *
 * @param {Object}   userProfile
 * @param {string}   userProfile.role               — current role name
 * @param {number}   [userProfile.experience_years=0]
 * @param {string[]} [userProfile.skills=[]]         — user skill names
 * @param {string}   [userProfile.industry=null]     — preferred industry filter
 * @param {string}   [userProfile.country=null]      — market data country filter
 * @param {number}   [userProfile.top_n=5]           — max results to return
 * @param {number}   [userProfile.chi_score=null]    — CHI score for opportunity blending
 *
 * @returns {Promise<{
 *   opportunities: Array<{role, match_score, ...}>,
 *   insights:      string[],
 *   meta:          Object
 * }>}
 */
async function analyzeCareerOpportunities(userProfile) {
  const {
    role,
    experience_years = 0,
    skills           = [],
    industry         = null,
    country          = null,
    top_n            = DEFAULT_TOP_N,
    chi_score        = null,
  } = userProfile || {};

  if (!role || typeof role !== 'string' || !role.trim()) {
    return {
      opportunities: [],
      insights:      ['role is required to analyze career opportunities'],
      meta:          { engine_version: 'opportunity_standalone_v1', error: 'missing_role' },
    };
  }

  const topN      = Math.min(Number(top_n) || DEFAULT_TOP_N, MAX_TOP_N);
  const normRole  = _norm(role);
  const expFactor = _experienceFactor(experience_years);
  const start     = Date.now();

  // ── 1. Load CSV transitions ──────────────────────────────────────────────
  const rows = await _loadCSV();

  // ── 2. Filter rows matching current role ────────────────────────────────
  const matchingRows = rows.filter(r => _norm(r.current_role) === normRole);

  // ── 3. Score each candidate role ────────────────────────────────────────
  const scored = matchingRows.map(row => {
    const overlap    = _computeSkillOverlap(row.skill_overlap_weight, skills, row.next_role);
    const matchScore = _computeMatchScore(overlap, expFactor);

    return {
      role:                 row.next_role,
      match_score:          matchScore,
      skill_overlap_weight: row.skill_overlap_weight,
      skill_overlap_ratio:  parseFloat(overlap.toFixed(3)),
      experience_factor:    parseFloat(expFactor.toFixed(3)),
    };
  });

  // ── 4. Sort by match_score desc, take topN ───────────────────────────────
  scored.sort((a, b) => b.match_score - a.match_score);
  const topOpportunities = scored.slice(0, topN);

  // ── 5. Attempt Firestore enrichment (non-blocking) ──────────────────────
  let firestoreResult = null;
  if (topOpportunities.length > 0) {
    firestoreResult = await _tryFirestoreEnrichment(role, chi_score, country, topN);
  }

  // ── 6. Merge Firestore market data into CSV results ──────────────────────
  let finalOpportunities = topOpportunities;

  if (firestoreResult?.career_opportunities?.length > 0) {
    const fsMap = new Map(
      firestoreResult.career_opportunities.map(o => [_norm(o.role), o])
    );

    finalOpportunities = topOpportunities.map(opp => {
      const fsData = fsMap.get(_norm(opp.role));
      if (!fsData) return opp;

      return {
        ...opp,
        opportunity_score:    fsData.opportunity_score   ?? opp.match_score,
        market_demand:        fsData.market_demand       ?? null,
        market_demand_score:  fsData.market_demand_score ?? null,
        growth_rate:          fsData.growth_rate         ?? null,
        job_postings:         fsData.job_postings        ?? null,
        remote_ratio:         fsData.remote_ratio        ?? null,
        competition_score:    fsData.competition_score   ?? null,
        steps_away:           fsData.steps_away          ?? 1,
        estimated_years:      fsData.estimated_years     ?? null,
        country:              fsData.country             ?? country ?? null,
      };
    });

    // Re-sort using opportunity_score when Firestore data is present
    finalOpportunities.sort((a, b) => (b.opportunity_score ?? b.match_score) - (a.opportunity_score ?? a.match_score));
  }

  const insights = _generateInsights(finalOpportunities, role);

  logger.info('[CareerOpportunityEngine] Analysis complete', {
    role,
    candidates:  scored.length,
    returned:    finalOpportunities.length,
    enriched:    !!firestoreResult,
    elapsed_ms:  Date.now() - start,
  });

  return {
    opportunities: finalOpportunities,
    insights,
    meta: {
      engine_version:   'opportunity_standalone_v1',
      role,
      experience_years: Number(experience_years) || 0,
      skill_count:      skills.length,
      total_candidates: scored.length,
      firestore_enriched: !!firestoreResult,
      country:          country ?? null,
      chi_score_used:   chi_score ?? null,
      calculated_at:    new Date().toISOString(),
    },
  };
}

/**
 * Invalidate the CSV cache.
 * Call this after hot-reloading role-transition.csv in development.
 */
function invalidateCache() {
  _cache.rows     = null;
  _cache.loadedAt = null;
  logger.info('[CareerOpportunityEngine] Cache invalidated');
}

module.exports = {
  analyzeCareerOpportunities,
  invalidateCache,
  // Exported for unit tests
  _computeMatchScore,
  _computeSkillOverlap,
  _experienceFactor,
};








