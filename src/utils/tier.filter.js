'use strict';

/**
 * tier.filter.js
 *
 * Filters a full CHI snapshot down to only the fields a user's plan
 * is entitled to see. Claude still generates the full structured output
 * once — this utility controls what the API exposes per tier.
 *
 * Tier hierarchy:
 *   free    → chiScore, dimensions, topStrength, trend (direction only)
 *   pro     → free + criticalGap, marketPosition, peerComparison, full trend
 *   premium → pro + projectedLevelUpMonths, currentEstimatedSalaryLPA,
 *                   nextLevelEstimatedSalaryLPA
 *
 * ADDING A NEW FIELD:
 *   1. Add it to the appropriate tier block below.
 *   2. That's it. Controller and service are untouched.
 *
 * CHANGING TIER BOUNDARIES:
 *   Move the field to a different tier block below.
 *   No other file needs to change.
 */

// ─── Tier hierarchy ───────────────────────────────────────────────────────────

const PLAN_HIERARCHY = ['free', 'pro', 'premium'];

/**
 * Returns true if the user's plan meets or exceeds the required tier.
 * Unknown plans default to 'free'.
 *
 * @param {string} userPlan   - Value from req.user.plan
 * @param {string} required   - Minimum tier required ('free'|'pro'|'premium')
 */
function meetsOrExceeds(userPlan, required) {
  const userLevel     = PLAN_HIERARCHY.indexOf(userPlan  ?? 'free');
  const requiredLevel = PLAN_HIERARCHY.indexOf(required);
  // If plan string is unrecognised, indexOf returns -1 → treated as below free
  return userLevel >= requiredLevel && userLevel !== -1;
}

// ─── Field maps ───────────────────────────────────────────────────────────────

/**
 * Builds a filtered snapshot object based on the user's plan.
 *
 * All fields present in the CHI snapshot are listed here, assigned to the
 * minimum tier required to see them.  Fields not listed are never exposed.
 *
 * @param {object} snapshot  - Full CHI snapshot returned by the service
 * @param {string} plan      - User plan: 'free' | 'pro' | 'premium'
 * @returns {object}         - Filtered snapshot safe to send to client
 */
function applyTierFilter(snapshot, plan) {
  if (!snapshot || typeof snapshot !== 'object') return {};

  const can = (tier) => meetsOrExceeds(plan, tier);

  // ── Always-present metadata (not business data, safe for all) ──────────────
  const base = {
    snapshotId:  snapshot.snapshotId,
    userId:      snapshot.userId,
    resumeId:    snapshot.resumeId,
    generatedAt: snapshot.generatedAt,
  };

  // ── Free tier ──────────────────────────────────────────────────────────────
  const free = {
    chiScore:    snapshot.chiScore,
    dimensions:  snapshot.dimensions,   // full dimension object (scores + insights)
    topStrength: snapshot.topStrength,

    // Partial trend — direction only. Delta and previousScore are pro.
    trend: snapshot.trend
      ? { direction: snapshot.trend.direction }
      : null,
  };

  // ── Pro tier ──────────────────────────────────────────────────────────────
  const pro = can('pro') ? {
    criticalGap:    snapshot.criticalGap,
    marketPosition: snapshot.marketPosition,
    peerComparison: snapshot.peerComparison,

    // Upgrade trend to full object
    trend: snapshot.trend ?? null,
  } : {};

  // ── Premium tier ──────────────────────────────────────────────────────────
  const premium = can('premium') ? {
    projectedLevelUpMonths:      snapshot.projectedLevelUpMonths,
    currentEstimatedSalaryLPA:   snapshot.currentEstimatedSalaryLPA,
    nextLevelEstimatedSalaryLPA: snapshot.nextLevelEstimatedSalaryLPA,
  } : {};

  // ── Merge in tier order ───────────────────────────────────────────────────
  // Pro's `trend` intentionally overwrites free's partial trend when plan qualifies.
  return {
    ...base,
    ...free,
    ...pro,
    ...premium,
    _plan: plan ?? 'free',   // surface active plan to client for UI gating
  };
}

/**
 * Filters a CHI history entry (lighter shape — trend + score only).
 * History is available to all tiers but delta is gated to pro+.
 *
 * @param {object} entry  - Single history record
 * @param {string} plan
 * @returns {object}
 */
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