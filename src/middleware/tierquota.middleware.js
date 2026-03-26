'use strict';

/**
 * tierQuota.middleware.js — Per-Tier AI Usage Quota Enforcement
 * =============================================================
 * PRODUCTION HARDENED — Phase 3
 *
 * ARCHITECTURE:
 *
 *   This middleware sits between authenticate and the route handler.
 *   It enforces monthly AI usage limits per tier BEFORE any Claude call fires.
 *
 *   Three-layer protection:
 *     Layer 1 → tierQuota    (this middleware — monthly limit check, fast read)
 *     Layer 2 → creditGuard  (per-operation credit check, existing middleware)
 *     Layer 3 → deductCredits (atomic Firestore transaction, existing in analysis.service.js)
 *
 *   This layer adds WHAT creditGuard doesn't cover:
 *     - Free tier monthly request caps (free users have no credits, so creditGuard
 *       passes them through — this middleware stops free abuse)
 *     - Per-feature rate limiting by tier
 *     - Usage counter increment after each successful request
 *
 * FREE TIER PROTECTION:
 *   Free tier users are the primary burn risk — they cost you money
 *   with zero revenue offset. This middleware caps them hard.
 *
 * QUOTA CONFIG (adjust monthly):
 *   Free  → 3 analyses/month, 5 job matches/month
 *   Pro   → unlimited (credits are the limiting factor, not this middleware)
 *
 * FIRESTORE USAGE COUNTERS:
 *   Collection: userQuota/{userId}/monthly/{YYYY-MM}
 *   Fields:     { feature: count, ...lastUpdated }
 *
 *   Documents are created on first use, incremented atomically.
 *   They expire naturally after 2 months via TTL field.
 *
 * USAGE:
 *   router.post('/analyze',
 *     authenticate,
 *     tierQuota('fullAnalysis'),  ← add this
 *     creditGuard('fullAnalysis'),
 *     analysisController
 *   );
 */

const { db, FieldValue, Timestamp } = require('../config/supabase');
const { AppError, ErrorCodes } = require('./errorHandler');
const logger = require('../utils/logger');

// ─── Quota configuration ──────────────────────────────────────────────────────
// null = unlimited (pro/enterprise — credits control spend, not monthly caps)

const TIER_MONTHLY_QUOTAS = {
  free: {
    fullAnalysis:     3,   // 3 full AI analyses per month
    generateCV:       1,   // 1 CV generation per month
    jobMatchAnalysis: 5,   // 5 job matches per month
    jobSpecificCV:    1,   // 1 tailored CV per month
    careerReport:     1,   // 1 career intelligence report per month
    salaryBenchmark:  10,  // 10 salary lookups (deterministic, cheap)
    default:          10,  // fallback for unlisted features
  },
  pro: {
    default: null,    // unlimited — credits are the gate
  },
  enterprise: {
    default: null,    // unlimited — contract-defined limits
  },
  premium: {
    default: null,    // unlimited
  },
};

// TTL: 60 days — documents auto-expire, no cleanup job needed
const QUOTA_DOC_TTL_DAYS = 60;

// ─── Helper: get current month key ────────────────────────────────────────────

function currentMonthKey() {
  const now = new Date();
  const y   = now.getUTCFullYear();
  const m   = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

// ─── Helper: get quota limit for tier + feature ───────────────────────────────

function getQuotaLimit(tier, feature) {
  const tierConfig = TIER_MONTHLY_QUOTAS[tier] ?? TIER_MONTHLY_QUOTAS['free'];
  if (feature in tierConfig) return tierConfig[feature];
  return tierConfig.default ?? 10;
}

// ─── Helper: TTL timestamp ────────────────────────────────────────────────────

function ttlTimestamp(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return Timestamp.fromDate(d);
}

// ─── Main middleware factory ───────────────────────────────────────────────────

/**
 * tierQuota(feature)
 *
 * @param {string} feature - The operation being rate-limited
 *                           (must match keys in TIER_MONTHLY_QUOTAS)
 * @returns Express middleware
 */
function tierQuota(feature) {
  return async function tierQuotaMiddleware(req, res, next) {
    const userId = req.user?.uid;
    const tier   = req.user?.plan ?? 'free';

    if (!userId) {
      return next(new AppError('Authentication required', 401, {}, ErrorCodes.UNAUTHORIZED));
    }

    const limit = getQuotaLimit(tier, feature);

    // Unlimited tier — pass through immediately, no Firestore read needed
    if (limit === null) {
      return next();
    }

    
    const monthKey  = currentMonthKey();
    // Query Supabase user_quota table directly (flat schema)
    const supabase = require('../core/supabaseClient');

    try {
      const { data: quotaRow } = await supabase
        .from('user_quota')
        .select('count')
        .eq('user_id', userId)
        .eq('month_key', monthKey)
        .eq('feature', feature)
        .maybeSingle();
      const current = quotaRow?.count ?? 0;

      if (current >= limit) {
        logger.warn('[TierQuota] Monthly limit reached', {
          userId,
          tier,
          feature,
          current,
          limit,
        });

        // FIX G-11: Include upgradeUrl + quotaExhausted flag directly in the 429.
        // Before this fix the frontend had to call GET /progress to discover
        // whether a step was locked, and had no upgradeUrl to link to.
        // Now the 429 itself carries everything needed to render the upgrade CTA.
        const upgradeUrl = process.env.UPGRADE_URL ?? '/pricing';
        return res.status(429).json({
          success:         false,
          errorCode:       'QUOTA_EXCEEDED',
          message:         `You've reached your monthly limit of ${limit} ${feature} requests on the ${tier} plan. Upgrade to Pro for unlimited access.`,
          quotaExhausted:  true,  // G-11: explicit boolean for frontend gating
          upgradeUrl,             // G-11: direct link — no second fetch needed
          details: {
            feature,
            limit,
            used:       current,
            resetDate:  `${currentMonthKey().split('-')[0]}-${String(parseInt(currentMonthKey().split('-')[1]) + 1).padStart(2, '0')}-01`,
            upgradeUrl,
          },
          timestamp: new Date().toISOString(),
        });
      }

      // ── Attach increment callback to req for post-response execution ────
      // We increment AFTER the response is sent, not before.
      // This prevents counting failed requests against quota.
      // The increment happens in the response finish hook below.
      // Register post-response hook to increment counter on success
      res.on('finish', () => {
        // Only count 2xx responses
        if (res.statusCode >= 200 && res.statusCode < 300) {
          // Upsert quota count in Supabase user_quota table
          supabase
            .from('user_quota')
            .upsert({
              user_id:      userId,
              month_key:    monthKey,
              feature:      feature,
              count:        (current + 1),
              last_updated: new Date().toISOString(),
              expires_at:   ttlTimestamp(QUOTA_DOC_TTL_DAYS),
            }, { onConflict: 'user_id,month_key,feature' })
            .then(() => {})
            .catch(err => {
              logger.error('[TierQuota] Failed to increment quota counter', {
                userId, feature, error: err.message,
              });
            });
        }
      });

      return next();

    } catch (err) {
      // HOTFIX: Quota check failure now returns 503 instead of failing open.
      // Previous behaviour silently called next(), allowing unlimited AI calls
      // during any Firestore outage. This is a significant cost-control risk.
      // A 503 is the correct signal: the service is temporarily unavailable,
      // not that the user is authorised to proceed without a quota check.
      logger.error('[TierQuota] Quota check failed — returning 503', {
        userId,
        feature,
        error: err.message,
      });
      return res.status(503).json({
        success:   false,
        errorCode: 'QUOTA_SERVICE_UNAVAILABLE',
        message:   'Usage quota service is temporarily unavailable. Please try again in a moment.',
        retryAfter: 30,
        timestamp: new Date().toISOString(),
      });
    }
  };
}

// ─── Admin: get quota usage for a user ────────────────────────────────────────

/**
 * getUserQuotaUsage(userId)
 * Returns current month's usage across all features.
 * Used by GET /users/me to show remaining quota to frontend.
 */
async function getUserQuotaUsage(userId) {
  
  const supabase = require('../core/supabaseClient');
  const monthKey = currentMonthKey();

  try {
    const { data: rows } = await supabase
      .from('user_quota')
      .select('feature, count')
      .eq('user_id', userId)
      .eq('month_key', monthKey);

    if (!rows || rows.length === 0) return {};
    return rows.reduce((acc, row) => { acc[row.feature] = row.count; return acc; }, {});
  } catch (err) {
    logger.error('[TierQuota] Failed to fetch quota usage', { userId, error: err.message });
    return {};
  }
}

/**
 * getRemainingQuota(userId, tier)
 * Returns { feature: remainingCount } map for the user's current quota.
 * Returns null for pro/enterprise (unlimited).
 */
async function getRemainingQuota(userId, tier) {
  const limit = getQuotaLimit(tier, 'default');
  if (limit === null) return null; // unlimited

  const usage    = await getUserQuotaUsage(userId);
  const tierConf = TIER_MONTHLY_QUOTAS[tier] ?? TIER_MONTHLY_QUOTAS['free'];
  const result   = {};

  for (const [feat, maxAllowed] of Object.entries(tierConf)) {
    if (feat === 'default' || maxAllowed === null) continue;
    const used = usage[feat] ?? 0;
    result[feat] = Math.max(0, maxAllowed - used);
  }

  return result;
}

module.exports = {
  tierQuota,
  getUserQuotaUsage,
  getRemainingQuota,
  TIER_MONTHLY_QUOTAS,
};









