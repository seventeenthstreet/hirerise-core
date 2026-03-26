'use strict';

/**
 * tier.filter.js — PHASE 1 UPDATE
 *
 * CHANGE: Added skillGaps, demandMetrics, salaryBenchmark to the free tier.
 * These three fields are required by SkillGapCard, MarketDemandCard, and
 * SalaryBenchmarkCard on the dashboard. They were previously missing from
 * all tier outputs, causing every dashboard card to show empty states.
 *
 * skillGaps[]     → free tier (core feature — users need to know what to fix)
 * demandMetrics[] → free tier (market signals — drives engagement)
 * salaryBenchmark → pro tier only (salary data is a premium upsell)
 *
 * ADDING A NEW FIELD:
 *   1. Add it to the appropriate tier block below.
 *   2. That's it. Controller and service are untouched.
 */

const PLAN_HIERARCHY = ['free', 'pro', 'premium'];

function meetsOrExceeds(userPlan, required) {
  const userLevel     = PLAN_HIERARCHY.indexOf(userPlan  ?? 'free');
  const requiredLevel = PLAN_HIERARCHY.indexOf(required);
  return userLevel >= requiredLevel && userLevel !== -1;
}

function applyTierFilter(snapshot, plan) {
  if (!snapshot || typeof snapshot !== 'object') return {};

  const can = (tier) => meetsOrExceeds(plan, tier);

  // ── Always-present metadata ───────────────────────────────────────────────
  const base = {
    snapshotId:     snapshot.snapshotId,
    user_id:         snapshot.userId,
    resumeId:       snapshot.resumeId,
    generatedAt:    snapshot.generatedAt,
    isReady:        snapshot.isReady        ?? false,
    lastCalculated: snapshot.lastCalculated ?? null,
    analysisSource: snapshot.analysisSource ?? null,
  };

  // ── Free tier ─────────────────────────────────────────────────────────────
  const free = {
    chiScore:       snapshot.chiScore,
    dimensions:     snapshot.dimensions,
    topStrength:    snapshot.topStrength,

    // PHASE 1 FIX: skill gaps and demand metrics are now free-tier features.
    // Users need to see what they're missing — this drives resume upload + upgrade.
    skillGaps:      snapshot.skillGaps     ?? [],
    demandMetrics:  snapshot.demandMetrics ?? [],

    // Partial trend — direction only. Delta and previousScore are pro.
    trend: snapshot.trend
      ? { direction: snapshot.trend.direction }
      : null,
  };

  // ── Pro tier ──────────────────────────────────────────────────────────────
  const pro = can('pro') ? {
    criticalGap:     snapshot.criticalGap,
    marketPosition:  snapshot.marketPosition,
    peerComparison:  snapshot.peerComparison,

    // PHASE 1 FIX: salary benchmark is a pro upsell — shows earning potential
    salaryBenchmark: snapshot.salaryBenchmark ?? null,

    // Upgrade trend to full object
    trend: snapshot.trend ?? null,
  } : {
    salaryBenchmark: null, // explicitly null for free — no partial data
  };

  // ── Premium tier ──────────────────────────────────────────────────────────
  const premium = can('premium') ? {
    projectedLevelUpMonths:      snapshot.projectedLevelUpMonths,
    currentEstimatedSalaryLPA:   snapshot.currentEstimatedSalaryLPA,
    nextLevelEstimatedSalaryLPA: snapshot.nextLevelEstimatedSalaryLPA,
  } : {};

  return {
    ...base,
    ...free,
    ...pro,
    ...premium,
    _plan: plan ?? 'free',
  };
}

function applyHistoryTierFilter(entry, plan) {
  if (!entry || typeof entry !== 'object') return {};

  const base = {
    snapshotId:  entry.snapshotId,
    chiScore:    entry.chiScore,
    generatedAt: entry.generatedAt,
  };

  const proFields = meetsOrExceeds(plan, 'pro') ? {
    marketPosition: entry.marketPosition,
    trend:          entry.trend ?? null,
  } : {
    trend: entry.trend ? { direction: entry.trend.direction } : null,
  };

  return { ...base, ...proFields };
}

module.exports = { applyTierFilter, applyHistoryTierFilter };








