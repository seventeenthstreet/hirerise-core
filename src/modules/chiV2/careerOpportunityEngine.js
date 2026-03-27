'use strict';

/**
 * careerOpportunityEngine.js — Career Opportunity Engine (Labor Market Intelligence)
 *
 * Analyses labor market demand data to rank reachable roles by opportunity,
 * combining CHI readiness with market pull signals.
 *
 * Data sources (all read-only Supabase):
 *   role_market_demand  — job postings, growth, competition, remote ratio
 *   role_transitions    — graph edges used to find reachable roles
 *   roles               — role metadata
 *
 * Scoring formula:
 *   MarketDemandScore  = normalized(job_postings)*0.40 + normalized(growth_rate)*0.30
 *                       + normalized(remote_ratio)*0.15 + (1-competition_score)*0.15
 *
 *   OpportunityScore   = chi_score*0.60 + MarketDemandScore*0.40
 *
 * SECURITY: Read-only Supabase. No writes. No auth mutations. No secrets.
 */
const supabase = require('../../config/supabase');
const logger = require('../../utils/logger');

// ─── Constants ────────────────────────────────────────────────────────────────

const DEMAND_WEIGHTS = Object.freeze({
  job_postings: 0.40,
  growth_rate: 0.30,
  remote_ratio: 0.15,
  competition_low: 0.15 // (1 - competition_score)
});

// Normalisation reference ceilings — these represent "best in class" values.
// Scores above these ceilings are clamped to 100.
const NORM_CEILINGS = Object.freeze({
  job_postings: 50_000,
  // 50k postings = saturated / maximum demand
  growth_rate: 50,
  // 50% YoY growth = extremely fast-growing
  remote_ratio: 1.0 // 100% remote = fully remote role
});

// Demand label thresholds (MarketDemandScore → human label)
const DEMAND_LABELS = [{
  min: 80,
  label: 'Very High'
}, {
  min: 60,
  label: 'High'
}, {
  min: 40,
  label: 'Moderate'
}, {
  min: 20,
  label: 'Low'
}, {
  min: 0,
  label: 'Very Low'
}];
const MAX_REACHABLE_HOPS = 4; // BFS depth for reachable role discovery
const MAX_OPPORTUNITIES = 10; // internal candidate pool
const TOP_RECOMMENDATIONS = 3; // returned to the user

// ─── Normalisation ────────────────────────────────────────────────────────────

/**
 * Normalise a raw value to 0–100 using a reference ceiling.
 * Values at or above the ceiling score 100.
 */
function normalise(value, ceiling) {
  if (!value || value <= 0 || !ceiling) return 0;
  return Math.min(Math.round(value / ceiling * 100), 100);
}

// ─── Market Demand Score ──────────────────────────────────────────────────────

/**
 * Compute MarketDemandScore (0–100) from a single role_market_demand document.
 */
function computeMarketDemandScore(doc) {
  const jobPostingsNorm = normalise(doc.job_postings, NORM_CEILINGS.job_postings);
  const growthRateNorm = normalise(doc.growth_rate, NORM_CEILINGS.growth_rate);
  const remoteRatioNorm = normalise(doc.remote_ratio, NORM_CEILINGS.remote_ratio);
  const competitionScore = Math.max(0, Math.min(1, Number(doc.competition_score) || 0.5));
  const raw = jobPostingsNorm * DEMAND_WEIGHTS.job_postings + growthRateNorm * DEMAND_WEIGHTS.growth_rate + remoteRatioNorm * DEMAND_WEIGHTS.remote_ratio + (1 - competitionScore) * 100 * DEMAND_WEIGHTS.competition_low;
  return Math.round(Math.min(raw, 100));
}

function demandLabel(score) {
  for (const { min, label } of DEMAND_LABELS) {
    if (score >= min) return label;
  }
  return 'Very Low';
}

// ─── Reachable Role Discovery ─────────────────────────────────────────────────

/**
 * BFS over role_transitions to find all roles reachable from currentRoleId
 * within MAX_REACHABLE_HOPS steps.
 *
 * Returns: Map<roleId, { steps, years }> — closest path to each reachable role.
 */
async function findReachableRoles(currentRoleId) {
  const reachable = new Map(); // roleId → { steps, years }
  const visited = new Set([currentRoleId]);
  const queue = [{
    id: currentRoleId,
    steps: 0,
    years: 0
  }];

  while (queue.length > 0) {
    const { id: current, steps, years } = queue.shift();
    if (steps >= MAX_REACHABLE_HOPS) continue;

    const { data, error } = await supabase.from('role_transitions').select('*').eq('from_role_id', current);
    if (error || !data) continue;

    for (const row of data) {
      const nextId = row.to_role_id;
      if (!nextId || visited.has(nextId)) continue;
      const nextSteps = steps + 1;
      const nextYears = years + (Number(row.years_required) || 0);
      visited.add(nextId);
      reachable.set(nextId, { steps: nextSteps, years: nextYears });
      queue.push({ id: nextId, steps: nextSteps, years: nextYears });
    }
  }
  return reachable;
}

// ─── Market Data Fetcher ──────────────────────────────────────────────────────

/**
 * Fetch market demand records for an array of role IDs.
 * Queries in batches of 10 to stay within safe IN-clause limits.
 * Returns a Map<roleId, demandDoc[]> — one role may have multiple country records.
 */
async function fetchMarketDemand(roleIds, country = null) {
  if (!roleIds || roleIds.length === 0) return new Map();
  const demandMap = new Map();
  const unique = [...new Set(roleIds)];
  const chunks = [];
  for (let i = 0; i < unique.length; i += 10) {
    chunks.push(unique.slice(i, i + 10));
  }

  const results = await Promise.all(
    chunks.map(chunk =>
      supabase.from('role_market_demand').select('*').in('role_id', chunk)
    )
  );

  results.forEach(({ data, error }) => {
    if (error || !data) return;
    data.forEach(row => {
      if (!demandMap.has(row.role_id)) demandMap.set(row.role_id, []);
      demandMap.get(row.role_id).push(row);
    });
  });

  // If a country filter is given, prefer country-specific records
  if (country) {
    for (const [roleId, records] of demandMap.entries()) {
      const countryMatch = records.filter(r => String(r.country).toLowerCase() === country.toLowerCase());
      if (countryMatch.length > 0) demandMap.set(roleId, countryMatch);
    }
  }
  return demandMap;
}

/**
 * Aggregate multiple demand records (multi-country) into a single document
 * by averaging numeric fields.
 */
function aggregateDemandRecords(records) {
  if (!records || records.length === 0) return null;
  if (records.length === 1) return records[0];
  const avg = field => {
    const vals = records.map(r => Number(r[field])).filter(v => !isNaN(v) && v > 0);
    return vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
  };
  return {
    role_id: records[0].role_id,
    country: 'Global',
    job_postings: Math.round(avg('job_postings')),
    growth_rate: Math.round(avg('growth_rate') * 10) / 10,
    competition_score: Math.round(avg('competition_score') * 100) / 100,
    remote_ratio: Math.round(avg('remote_ratio') * 100) / 100
  };
}

// ─── Role Metadata ────────────────────────────────────────────────────────────

async function fetchRolesMeta(roleIds) {
  if (!roleIds || roleIds.length === 0) return {};
  const meta = {};
  const results = await Promise.all(
    roleIds.map(id =>
      supabase.from('roles').select('*').eq('id', id).maybeSingle()
    )
  );
  results.forEach(({ data }, i) => {
    meta[roleIds[i]] = data
      ? { id: data.id, ...data }
      : { id: roleIds[i], role_name: roleIds[i] };
  });
  return meta;
}

// ─── Opportunity Score ────────────────────────────────────────────────────────

/**
 * OpportunityScore = chiScore * 0.60 + marketDemandScore * 0.40
 * When chi_score is unknown (null), weight shifts: 0/40 → demand only.
 */
function computeOpportunityScore(chiScore, marketDemandScore) {
  if (chiScore == null) return marketDemandScore;
  return Math.round(chiScore * 0.60 + marketDemandScore * 0.40);
}

// ─── Insights Generator ───────────────────────────────────────────────────────

function generateMarketInsights(opportunities, country) {
  const insights = [];
  for (const opp of opportunities.slice(0, 3)) {
    const d = opp.demand_detail;
    if (!d) continue;
    if (d.growth_rate >= 20) {
      insights.push(`${opp.role_name} demand has grown ${d.growth_rate}% this year`);
    }
    if (d.remote_ratio >= 0.4) {
      const pct = Math.round(d.remote_ratio * 100);
      insights.push(`Remote opportunities for ${opp.role_name} make up ${pct}% of postings`);
    }
    if (d.competition_score <= 0.35) {
      insights.push(`Competition for ${opp.role_name} roles is relatively low — a strong entry window`);
    }
    if (d.job_postings >= 10_000) {
      insights.push(`${opp.role_name} has ${d.job_postings.toLocaleString()} open positions — very high hiring activity`);
    }
  }

  // Top opportunity
  if (opportunities.length > 0) {
    const top = opportunities[0];
    insights.push(`${top.role_name} is your highest opportunity role with a score of ${top.opportunity_score}`);
  }
  if (insights.length === 0) {
    insights.push('Market data is limited for reachable roles — check back after importing role_market_demand data');
  }
  return [...new Set(insights)].slice(0, 5);
}

// ─── Admin Market Panel ───────────────────────────────────────────────────────

/**
 * getMarketIntelligenceSummary(country?) → panel data for the admin dashboard
 *
 * Returns top growing, top demand, and top salary roles from role_market_demand
 * joined with role_salary_market.
 */
async function getMarketIntelligenceSummary(country = null) {
  let query = supabase.from('role_market_demand').select('*');
  if (country) query = query.eq('country', country);

  const { data: records, error } = await query;

  if (error || !records || records.length === 0) {
    return {
      top_growing_roles: [],
      top_demand_roles: [],
      top_salary_roles: [],
      total_records: 0,
      country: country ?? 'Global'
    };
  }

  // Deduplicate by role_id — keep highest job_postings record per role
  const byRole = new Map();
  for (const rec of records) {
    const existing = byRole.get(rec.role_id);
    if (!existing || (rec.job_postings || 0) > (existing.job_postings || 0)) {
      byRole.set(rec.role_id, rec);
    }
  }
  const uniqueRecords = Array.from(byRole.values());
  const roleIds = uniqueRecords.map(r => r.role_id).filter(Boolean);
  const roleMeta = await fetchRolesMeta(roleIds);

  // Fetch salary data for these roles
  const salaryMap = {};
  if (roleIds.length > 0) {
    const salaryChunks = [];
    for (let i = 0; i < roleIds.length; i += 10) salaryChunks.push(roleIds.slice(i, i + 10));

    const salaryResults = await Promise.all(
      salaryChunks.map(chunk =>
        supabase.from('role_salary_market').select('*').in('role_id', chunk)
      )
    );
    salaryResults.forEach(({ data: salaryData, error: salaryError }) => {
      if (salaryError || !salaryData) return;
      salaryData.forEach(row => {
        if (!salaryMap[row.role_id] || (row.median_salary || 0) > (salaryMap[row.role_id] || 0)) {
          salaryMap[row.role_id] = row.median_salary;
        }
      });
    });
  }

  const enriched = uniqueRecords.map(rec => ({
    role_id: rec.role_id,
    role_name: roleMeta[rec.role_id]?.role_name ?? rec.role_id,
    role_family: roleMeta[rec.role_id]?.role_family ?? null,
    job_postings: rec.job_postings ?? 0,
    growth_rate: rec.growth_rate ?? 0,
    competition_score: rec.competition_score ?? 0.5,
    remote_ratio: rec.remote_ratio ?? 0,
    demand_score: computeMarketDemandScore(rec),
    demand_label: demandLabel(computeMarketDemandScore(rec)),
    median_salary: salaryMap[rec.role_id] ?? null,
    country: rec.country ?? 'Global',
    last_updated: rec.last_updated ?? null
  }));

  // Top Growing Roles — by growth_rate desc
  const top_growing_roles = [...enriched]
    .sort((a, b) => (b.growth_rate || 0) - (a.growth_rate || 0))
    .slice(0, 5)
    .map(r => ({
      role_id: r.role_id,
      role_name: r.role_name,
      role_family: r.role_family,
      growth_rate: r.growth_rate,
      demand_label: r.demand_label,
      job_postings: r.job_postings
    }));

  // Top Demand Roles — by demand_score desc
  const top_demand_roles = [...enriched]
    .sort((a, b) => (b.demand_score || 0) - (a.demand_score || 0))
    .slice(0, 5)
    .map(r => ({
      role_id: r.role_id,
      role_name: r.role_name,
      role_family: r.role_family,
      demand_score: r.demand_score,
      demand_label: r.demand_label,
      job_postings: r.job_postings,
      remote_ratio: r.remote_ratio
    }));

  // Top Salary Roles — by median_salary desc (only roles with salary data)
  const top_salary_roles = [...enriched]
    .filter(r => r.median_salary > 0)
    .sort((a, b) => (b.median_salary || 0) - (a.median_salary || 0))
    .slice(0, 5)
    .map(r => ({
      role_id: r.role_id,
      role_name: r.role_name,
      role_family: r.role_family,
      median_salary: r.median_salary,
      growth_rate: r.growth_rate,
      demand_label: r.demand_label
    }));

  return {
    top_growing_roles,
    top_demand_roles,
    top_salary_roles,
    total_records: records.length,
    country: country ?? 'Global',
    generated_at: new Date().toISOString()
  };
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * analyseCareerOpportunities(profile, options) → CareerOpportunityResult
 *
 * @param {Object} profile
 * @param {string}      profile.current_role_id  — resolved Supabase row ID
 * @param {number|null} profile.chi_score        — from CHI v2 (can be null)
 * @param {Object} options
 * @param {string}      options.country          — filter market data by country
 * @param {number}      options.top_n            — number of recommendations (default 3)
 *
 * @returns {Promise<CareerOpportunityResult>}
 */
async function analyseCareerOpportunities(profile, options = {}) {
  const {
    current_role_id,
    chi_score = null
  } = profile;
  const country = options.country ?? null;
  const topN = Math.min(Number(options.top_n) || TOP_RECOMMENDATIONS, 10);
  const start = Date.now();

  // ── 1. Find reachable roles via BFS ─────────────────────────────────────
  if (!current_role_id) {
    return {
      career_opportunities: [],
      insights: ['Provide a current_role to discover career opportunities'],
      meta: {
        engine_version: 'opportunity_v1',
        total_candidates: 0
      }
    };
  }
  const reachableMap = await findReachableRoles(current_role_id);
  if (reachableMap.size === 0) {
    return {
      career_opportunities: [],
      insights: ['No reachable roles found in the graph from your current role'],
      meta: {
        engine_version: 'opportunity_v1',
        total_candidates: 0
      }
    };
  }
  const reachableIds = [...reachableMap.keys()].slice(0, MAX_OPPORTUNITIES);

  // ── 2. Fetch market demand + role metadata in parallel ─────────────────
  const [demandMap, roleMeta] = await Promise.all([
    fetchMarketDemand(reachableIds, country),
    fetchRolesMeta(reachableIds)
  ]);

  // ── 3. Score each reachable role ───────────────────────────────────────
  const scored = [];
  for (const roleId of reachableIds) {
    const pathInfo = reachableMap.get(roleId);
    const rawRecords = demandMap.get(roleId);
    const role = roleMeta[roleId] ?? { id: roleId, role_name: roleId };

    // Skip roles with no market data
    if (!rawRecords || rawRecords.length === 0) continue;
    const demandDoc = aggregateDemandRecords(rawRecords);
    const demandScore = computeMarketDemandScore(demandDoc);
    const oppScore = computeOpportunityScore(chi_score, demandScore);
    scored.push({
      role_id: roleId,
      role_name: role.role_name ?? roleId,
      role_family: role.role_family ?? null,
      seniority_level: role.seniority_level ?? null,
      opportunity_score: oppScore,
      market_demand: demandLabel(demandScore),
      market_demand_score: demandScore,
      growth_rate: demandDoc.growth_rate ?? 0,
      job_postings: demandDoc.job_postings ?? 0,
      remote_ratio: demandDoc.remote_ratio ?? 0,
      competition_score: demandDoc.competition_score ?? 0.5,
      steps_away: pathInfo?.steps ?? 1,
      estimated_years: pathInfo?.years ?? 0,
      country: demandDoc.country ?? country ?? 'Global',
      demand_detail: demandDoc
    });
  }

  // ── 4. Rank by opportunity_score desc ─────────────────────────────────
  scored.sort((a, b) => b.opportunity_score - a.opportunity_score);
  const topOpportunities = scored.slice(0, topN);

  // ── 5. Generate insights ───────────────────────────────────────────────
  const insights = generateMarketInsights(topOpportunities, country);
  logger.info('[OpportunityEngine] Analysis complete', {
    current_role_id,
    candidates: scored.length,
    top_n: topN,
    elapsed_ms: Date.now() - start
  });

  // ── 6. Format output ───────────────────────────────────────────────────
  return {
    career_opportunities: topOpportunities.map(o => ({
      role: o.role_name,
      role_id: o.role_id,
      role_family: o.role_family,
      opportunity_score: o.opportunity_score,
      market_demand: o.market_demand,
      market_demand_score: o.market_demand_score,
      growth_rate: o.growth_rate,
      job_postings: o.job_postings,
      remote_ratio: o.remote_ratio,
      competition_score: o.competition_score,
      steps_away: o.steps_away,
      estimated_years: o.estimated_years,
      country: o.country
    })),
    insights,
    meta: {
      engine_version: 'opportunity_v1',
      current_role_id,
      total_candidates: scored.length,
      total_reachable: reachableMap.size,
      country: country ?? 'Global',
      chi_score_used: chi_score,
      calculated_at: new Date().toISOString()
    }
  };
}

module.exports = {
  analyseCareerOpportunities,
  getMarketIntelligenceSummary,
  computeMarketDemandScore,
  computeOpportunityScore,
  findReachableRoles,
  demandLabel,
  normalise,
  DEMAND_WEIGHTS,
  NORM_CEILINGS
};