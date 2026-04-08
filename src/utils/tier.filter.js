'use strict';

/**
 * tier.filter.js
 *
 * Product access control filter for dashboard snapshots.
 *
 * Goals:
 * - prevent premium data leaks
 * - stable free/pro/premium contracts
 * - future enterprise tier extensibility
 */

const PLAN_HIERARCHY = Object.freeze(['free', 'pro', 'premium']);

/**
 * Normalize plan safely.
 *
 * @param {string} plan
 * @returns {'free'|'pro'|'premium'}
 */
function normalizePlan(plan) {
  return PLAN_HIERARCHY.includes(plan) ? plan : 'free';
}

/**
 * Check plan hierarchy access.
 *
 * @param {string} userPlan
 * @param {string} required
 * @returns {boolean}
 */
function meetsOrExceeds(userPlan, required) {
  const normalizedUserPlan = normalizePlan(userPlan);
  const userLevel = PLAN_HIERARCHY.indexOf(normalizedUserPlan);
  const requiredLevel = PLAN_HIERARCHY.indexOf(required);

  return userLevel >= requiredLevel;
}

/**
 * Safely expose trend object by tier.
 *
 * @param {object|null} trend
 * @param {string} plan
 * @returns {object|null}
 */
function filterTrend(trend, plan) {
  if (!trend || typeof trend !== 'object') {
    return null;
  }

  if (meetsOrExceeds(plan, 'pro')) {
    return trend;
  }

  return {
    direction: trend.direction ?? null,
  };
}

/**
 * Apply snapshot tier filtering.
 *
 * @param {object} snapshot
 * @param {string} plan
 * @returns {object}
 */
function applyTierFilter(snapshot, plan) {
  if (!snapshot || typeof snapshot !== 'object') {
    return {};
  }

  const safePlan = normalizePlan(plan);

  const response = {
    snapshotId: snapshot.snapshotId ?? null,
    user_id: snapshot.userId ?? null,
    resumeId: snapshot.resumeId ?? null,
    generatedAt: snapshot.generatedAt ?? null,
    isReady: snapshot.isReady ?? false,
    lastCalculated: snapshot.lastCalculated ?? null,
    analysisSource: snapshot.analysisSource ?? null,

    // Free tier
    chiScore: snapshot.chiScore ?? null,
    dimensions: snapshot.dimensions ?? [],
    topStrength: snapshot.topStrength ?? null,
    skillGaps: snapshot.skillGaps ?? [],
    demandMetrics: snapshot.demandMetrics ?? [],
    trend: filterTrend(snapshot.trend, safePlan),

    _plan: safePlan,
  };

  if (meetsOrExceeds(safePlan, 'pro')) {
    response.criticalGap = snapshot.criticalGap ?? null;
    response.marketPosition = snapshot.marketPosition ?? null;
    response.peerComparison = snapshot.peerComparison ?? null;
    response.salaryBenchmark = snapshot.salaryBenchmark ?? null;
  } else {
    response.salaryBenchmark = null;
  }

  if (meetsOrExceeds(safePlan, 'premium')) {
    response.projectedLevelUpMonths =
      snapshot.projectedLevelUpMonths ?? null;

    response.currentEstimatedSalaryLPA =
      snapshot.currentEstimatedSalaryLPA ?? null;

    response.nextLevelEstimatedSalaryLPA =
      snapshot.nextLevelEstimatedSalaryLPA ?? null;
  }

  return response;
}

/**
 * Apply historical snapshot tier filtering.
 *
 * @param {object} entry
 * @param {string} plan
 * @returns {object}
 */
function applyHistoryTierFilter(entry, plan) {
  if (!entry || typeof entry !== 'object') {
    return {};
  }

  const safePlan = normalizePlan(plan);

  const response = {
    snapshotId: entry.snapshotId ?? null,
    chiScore: entry.chiScore ?? null,
    generatedAt: entry.generatedAt ?? null,
    trend: filterTrend(entry.trend, safePlan),
  };

  if (meetsOrExceeds(safePlan, 'pro')) {
    response.marketPosition = entry.marketPosition ?? null;
  }

  return response;
}

module.exports = {
  applyTierFilter,
  applyHistoryTierFilter,
};