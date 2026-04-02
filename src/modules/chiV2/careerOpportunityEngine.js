'use strict';

/**
 * src/modules/chiv2/careerOpportunityEngine.js
 *
 * Production-grade Supabase optimized version.
 * Fully removes Firestore-era N+1 query patterns while preserving
 * original business behavior and exports.
 */

const { supabase } = require('../../config/supabase');
const logger = require('../../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEMAND_WEIGHTS = Object.freeze({
  job_postings: 0.4,
  growth_rate: 0.3,
  remote_ratio: 0.15,
  competition_low: 0.15
});

const NORM_CEILINGS = Object.freeze({
  job_postings: 50000,
  growth_rate: 50,
  remote_ratio: 1
});

const DEMAND_LABELS = Object.freeze([
  { min: 80, label: 'Very High' },
  { min: 60, label: 'High' },
  { min: 40, label: 'Moderate' },
  { min: 20, label: 'Low' },
  { min: 0, label: 'Very Low' }
]);

const MAX_REACHABLE_HOPS = 4;
const MAX_OPPORTUNITIES = 10;
const TOP_RECOMMENDATIONS = 3;
const SAFE_BATCH_SIZE = 100;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function chunkArray(items, size = SAFE_BATCH_SIZE) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function normalise(value, ceiling) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0 || !ceiling) return 0;
  return Math.min(Math.round((numeric / ceiling) * 100), 100);
}

function demandLabel(score) {
  for (const row of DEMAND_LABELS) {
    if (score >= row.min) return row.label;
  }
  return 'Very Low';
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring
// ─────────────────────────────────────────────────────────────────────────────

function computeMarketDemandScore(doc) {
  if (!doc) return 0;

  const jobPostingsNorm = normalise(
    doc.job_postings,
    NORM_CEILINGS.job_postings
  );
  const growthRateNorm = normalise(
    doc.growth_rate,
    NORM_CEILINGS.growth_rate
  );
  const remoteRatioNorm = normalise(
    doc.remote_ratio,
    NORM_CEILINGS.remote_ratio
  );

  const competitionScore = Math.max(
    0,
    Math.min(1, Number(doc.competition_score) || 0.5)
  );

  const raw =
    jobPostingsNorm * DEMAND_WEIGHTS.job_postings +
    growthRateNorm * DEMAND_WEIGHTS.growth_rate +
    remoteRatioNorm * DEMAND_WEIGHTS.remote_ratio +
    (1 - competitionScore) * 100 * DEMAND_WEIGHTS.competition_low;

  return Math.min(100, Math.round(raw));
}

function computeOpportunityScore(chiScore, marketDemandScore) {
  if (chiScore == null) return marketDemandScore;
  return Math.round(chiScore * 0.6 + marketDemandScore * 0.4);
}

// ─────────────────────────────────────────────────────────────────────────────
// Reachability (Optimized BFS)
// ─────────────────────────────────────────────────────────────────────────────

async function findReachableRoles(currentRoleId) {
  const reachable = new Map();
  const visited = new Set([currentRoleId]);

  let frontier = [{ id: currentRoleId, steps: 0, years: 0 }];

  for (let depth = 0; depth < MAX_REACHABLE_HOPS; depth++) {
    const currentIds = frontier.map(node => node.id);
    if (!currentIds.length) break;

    const { data, error } = await supabase
      .from('role_transitions')
      .select('from_role_id,to_role_id,years_required')
      .in('from_role_id', currentIds);

    if (error) {
      logger.warn('[CareerOpportunityEngine] BFS degraded', {
        depth,
        error: error.message
      });
      break;
    }

    const grouped = new Map();
    for (const row of data || []) {
      if (!grouped.has(row.from_role_id)) {
        grouped.set(row.from_role_id, []);
      }
      grouped.get(row.from_role_id).push(row);
    }

    const nextFrontier = [];

    for (const node of frontier) {
      const edges = grouped.get(node.id) || [];

      for (const edge of edges) {
        const nextId = edge.to_role_id;
        if (!nextId || visited.has(nextId)) continue;

        const nextSteps = node.steps + 1;
        const nextYears = node.years + (Number(edge.years_required) || 0);

        visited.add(nextId);
        reachable.set(nextId, {
          steps: nextSteps,
          years: nextYears
        });

        nextFrontier.push({
          id: nextId,
          steps: nextSteps,
          years: nextYears
        });
      }
    }

    frontier = nextFrontier;
  }

  return reachable;
}

// ─────────────────────────────────────────────────────────────────────────────
// Market Demand
// ─────────────────────────────────────────────────────────────────────────────

async function fetchMarketDemand(roleIds, country = null) {
  if (!Array.isArray(roleIds) || !roleIds.length) return new Map();

  const demandMap = new Map();
  const uniqueIds = [...new Set(roleIds)];

  const queries = chunkArray(uniqueIds).map(chunk =>
    supabase
      .from('role_market_demand')
      .select(
        'role_id,country,job_postings,growth_rate,competition_score,remote_ratio,last_updated'
      )
      .in('role_id', chunk)
  );

  const results = await Promise.allSettled(queries);

  for (const result of results) {
    if (result.status !== 'fulfilled') continue;

    const { data, error } = result.value;
    if (error || !data) continue;

    for (const row of data) {
      if (!demandMap.has(row.role_id)) {
        demandMap.set(row.role_id, []);
      }
      demandMap.get(row.role_id).push(row);
    }
  }

  if (country) {
    const normalizedCountry = String(country).toLowerCase();

    for (const [roleId, rows] of demandMap.entries()) {
      const filtered = rows.filter(
        row => String(row.country || '').toLowerCase() === normalizedCountry
      );

      if (filtered.length) {
        demandMap.set(roleId, filtered);
      }
    }
  }

  return demandMap;
}

function aggregateDemandRecords(records) {
  if (!records?.length) return null;
  if (records.length === 1) return records[0];

  const avg = field => {
    const values = records
      .map(r => Number(r[field]))
      .filter(v => Number.isFinite(v));

    if (!values.length) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  };

  return {
    role_id: records[0].role_id,
    country: 'Global',
    job_postings: Math.round(avg('job_postings')),
    growth_rate: Number(avg('growth_rate').toFixed(1)),
    competition_score: Number(avg('competition_score').toFixed(2)),
    remote_ratio: Number(avg('remote_ratio').toFixed(2))
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Metadata
// ─────────────────────────────────────────────────────────────────────────────

async function fetchRolesMeta(roleIds) {
  if (!roleIds?.length) return {};

  const { data, error } = await supabase
    .from('roles')
    .select('id,role_name,role_family,seniority_level')
    .in('id', [...new Set(roleIds)]);

  if (error) {
    logger.warn('[CareerOpportunityEngine] Role metadata degraded', {
      error: error.message
    });
    return {};
  }

  const meta = {};
  for (const row of data || []) {
    meta[row.id] = row;
  }

  return meta;
}

// ─────────────────────────────────────────────────────────────────────────────
// Insights
// ─────────────────────────────────────────────────────────────────────────────

function generateMarketInsights(opportunities) {
  const insights = [];

  for (const opp of opportunities.slice(0, 3)) {
    const d = opp.demand_detail;
    if (!d) continue;

    if (d.growth_rate >= 20) {
      insights.push(`${opp.role_name} demand has grown ${d.growth_rate}% this year`);
    }

    if (d.remote_ratio >= 0.4) {
      insights.push(
        `Remote opportunities for ${opp.role_name} make up ${Math.round(
          d.remote_ratio * 100
        )}% of postings`
      );
    }

    if (d.competition_score <= 0.35) {
      insights.push(
        `Competition for ${opp.role_name} roles is relatively low — a strong entry window`
      );
    }

    if (d.job_postings >= 10000) {
      insights.push(
        `${opp.role_name} has ${d.job_postings.toLocaleString()} open positions — very high hiring activity`
      );
    }
  }

  if (opportunities[0]) {
    insights.push(
      `${opportunities[0].role_name} is your highest opportunity role with a score of ${opportunities[0].opportunity_score}`
    );
  }

  if (!insights.length) {
    insights.push(
      'Market data is limited for reachable roles — check back after importing role_market_demand data'
    );
  }

  return [...new Set(insights)].slice(0, 5);
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin Summary (Preserved Export)
// ─────────────────────────────────────────────────────────────────────────────

async function getMarketIntelligenceSummary(country = null) {
  let query = supabase
    .from('role_market_demand')
    .select(
      'role_id,country,job_postings,growth_rate,competition_score,remote_ratio,last_updated'
    );

  if (country) {
    query = query.eq('country', country);
  }

  const { data: records, error } = await query;

  if (error || !records?.length) {
    return {
      top_growing_roles: [],
      top_demand_roles: [],
      top_salary_roles: [],
      total_records: 0,
      country: country ?? 'Global'
    };
  }

  const byRole = new Map();

  for (const rec of records) {
    const existing = byRole.get(rec.role_id);
    if (!existing || (rec.job_postings || 0) > (existing.job_postings || 0)) {
      byRole.set(rec.role_id, rec);
    }
  }

  const uniqueRecords = [...byRole.values()];
  const roleIds = uniqueRecords.map(r => r.role_id).filter(Boolean);
  const roleMeta = await fetchRolesMeta(roleIds);

  const salaryMap = {};
  if (roleIds.length) {
    const salaryResults = await Promise.allSettled(
      chunkArray(roleIds).map(chunk =>
        supabase
          .from('role_salary_market')
          .select('role_id,median_salary')
          .in('role_id', chunk)
      )
    );

    for (const result of salaryResults) {
      if (result.status !== 'fulfilled') continue;

      const { data } = result.value;
      for (const row of data || []) {
        if (
          !salaryMap[row.role_id] ||
          row.median_salary > salaryMap[row.role_id]
        ) {
          salaryMap[row.role_id] = row.median_salary;
        }
      }
    }
  }

  const enriched = uniqueRecords.map(rec => {
    const demandScore = computeMarketDemandScore(rec);

    return {
      role_id: rec.role_id,
      role_name: roleMeta[rec.role_id]?.role_name ?? rec.role_id,
      role_family: roleMeta[rec.role_id]?.role_family ?? null,
      job_postings: rec.job_postings ?? 0,
      growth_rate: rec.growth_rate ?? 0,
      competition_score: rec.competition_score ?? 0.5,
      remote_ratio: rec.remote_ratio ?? 0,
      demand_score: demandScore,
      demand_label: demandLabel(demandScore),
      median_salary: salaryMap[rec.role_id] ?? null,
      country: rec.country ?? 'Global',
      last_updated: rec.last_updated ?? null
    };
  });

  return {
    top_growing_roles: [...enriched]
      .sort((a, b) => b.growth_rate - a.growth_rate)
      .slice(0, 5),

    top_demand_roles: [...enriched]
      .sort((a, b) => b.demand_score - a.demand_score)
      .slice(0, 5),

    top_salary_roles: [...enriched]
      .filter(r => r.median_salary > 0)
      .sort((a, b) => b.median_salary - a.median_salary)
      .slice(0, 5),

    total_records: records.length,
    country: country ?? 'Global',
    generated_at: new Date().toISOString()
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function analyseCareerOpportunities(profile, options = {}) {
  const start = Date.now();

  const currentRoleId = profile?.current_role_id;
  const chiScore = profile?.chi_score ?? null;
  const country = options.country ?? null;
  const topN = Math.min(Number(options.top_n) || TOP_RECOMMENDATIONS, 10);

  if (!currentRoleId) {
    return {
      career_opportunities: [],
      insights: ['Provide a current_role to discover career opportunities'],
      meta: { engine_version: 'opportunity_v2' }
    };
  }

  const reachableMap = await findReachableRoles(currentRoleId);

  if (!reachableMap.size) {
    return {
      career_opportunities: [],
      insights: ['No reachable roles found in the graph from your current role'],
      meta: { engine_version: 'opportunity_v2' }
    };
  }

  const reachableIds = [...reachableMap.keys()].slice(0, MAX_OPPORTUNITIES);

  const [demandMap, roleMeta] = await Promise.all([
    fetchMarketDemand(reachableIds, country),
    fetchRolesMeta(reachableIds)
  ]);

  const scored = [];

  for (const roleId of reachableIds) {
    const demandRows = demandMap.get(roleId);
    if (!demandRows?.length) continue;

    const demandDoc = aggregateDemandRecords(demandRows);
    const demandScore = computeMarketDemandScore(demandDoc);
    const opportunityScore = computeOpportunityScore(chiScore, demandScore);
    const role = roleMeta[roleId] || {};
    const pathInfo = reachableMap.get(roleId);

    scored.push({
      role: role.role_name || roleId,
      role_id: roleId,
      role_family: role.role_family || null,
      seniority_level: role.seniority_level || null,
      opportunity_score: opportunityScore,
      market_demand: demandLabel(demandScore),
      market_demand_score: demandScore,
      growth_rate: demandDoc.growth_rate || 0,
      job_postings: demandDoc.job_postings || 0,
      remote_ratio: demandDoc.remote_ratio || 0,
      competition_score: demandDoc.competition_score || 0.5,
      steps_away: pathInfo?.steps || 1,
      estimated_years: pathInfo?.years || 0,
      country: demandDoc.country || country || 'Global',
      demand_detail: demandDoc
    });
  }

  scored.sort((a, b) => b.opportunity_score - a.opportunity_score);

  const topOpportunities = scored.slice(0, topN);

  logger.info('[CareerOpportunityEngine] Analysis complete', {
    current_role_id: currentRoleId,
    candidates: scored.length,
    top_n: topN,
    elapsed_ms: Date.now() - start
  });

  return {
    career_opportunities: topOpportunities,
    insights: generateMarketInsights(topOpportunities),
    meta: {
      engine_version: 'opportunity_v2',
      current_role_id: currentRoleId,
      total_candidates: scored.length,
      total_reachable: reachableMap.size,
      country: country || 'Global',
      chi_score_used: chiScore,
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